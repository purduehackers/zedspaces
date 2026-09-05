//! `zs-agent` command-line front end (brief §3.17; CONTRACTS.md §7.1).
//!
//! Exit codes: 0 ok, 1 generic, 2 config error (incl. `start` under `ZS_PREBUILD=1`), 3 manifest
//! unavailable, 4 repository materialisation failed. `credential`, `port-token`, `proxy` and
//! `warm` do not read `Config` (they must work without `ZS_SANDBOX_TOKEN`).

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{anyhow, bail};
use clap::{Parser, Subcommand};
use rand::RngCore as _;

use zs_agent::config::{Config, ConfigError, DEFAULT_SERVER_BIN, DEFAULT_SUPERVISOR_URL};
use zs_agent::credential;
use zs_agent::logs;
use zs_agent::port_auth::{PortSession, PortTokenCodec, decode_secret};
use zs_agent::proxy::{self, ProxyArgs};
use zs_agent::start::{self, BootError, EXIT_CONFIG, EXIT_GENERIC, EXIT_OK, StartArgs};
use zs_agent::warm::{self, WarmArgs};

#[derive(Parser)]
#[command(name = "zs-agent", version = env!("CARGO_PKG_VERSION"), disable_help_subcommand = true)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Boot the workspace and supervise zed-remote-server (create and resume).
    Start(StartArgs),
    /// `start --resumed` (what the control plane's onResume runs).
    Resume,
    /// Prebuild boot: clone, postCreate, LSP warm-up, exit 0 (requires ZS_PREBUILD=1).
    Prebuild,
    /// git credential helper (`credential.helper = !zs-agent credential`).
    Credential {
        /// `get`, `store` or `erase`.
        operation: String,
        /// Supervisor loopback API base.
        #[arg(long, env = "ZS_SUPERVISOR_URL", default_value = DEFAULT_SUPERVISOR_URL)]
        supervisor_url: String,
        /// Path of the control secret file.
        #[arg(long, env = "ZS_CONTROL_SECRET_FILE")]
        control_secret_file: Option<PathBuf>,
    },
    /// Run only the private-port auth proxy slots (tests / manual).
    Proxy(ProxyArgs),
    /// Send SIGTERM to the running agent (pid file) and wait for it to exit.
    Stop {
        /// Seconds to wait for the exit.
        #[arg(long, default_value_t = 30)]
        timeout_secs: u64,
    },
    /// Poll the health listener until status ready|degraded and phase ready (exit 0) or timeout (exit 1).
    WaitReady {
        /// Seconds to wait.
        #[arg(long, default_value_t = 120)]
        timeout_secs: u64,
        /// Accept `degraded` as ready.
        #[arg(long)]
        allow_degraded: bool,
    },
    /// Mint a port bootstrap token (HMAC `v1.` format) for tests / local runs.
    #[command(hide = true)]
    PortToken {
        /// Standard base64 `portSessionSecret`.
        #[arg(long, conflicts_with = "secret_file")]
        secret_b64: Option<String>,
        /// File holding the base64 secret.
        #[arg(long)]
        secret_file: Option<PathBuf>,
        /// `ws` claim.
        #[arg(long)]
        workspace_id: String,
        /// Target port.
        #[arg(long)]
        port: u16,
        /// Lifetime in seconds.
        #[arg(long, default_value_t = 3600)]
        ttl_secs: u64,
        /// `sub` claim.
        #[arg(long, default_value = "local")]
        sub: String,
    },
    /// Run the LSP warm-up client against a running server (tests / operators).
    #[command(hide = true)]
    Warm(WarmArgs),
    /// Print build id and the server binary's `version` output.
    Version,
}

/// `PR_SET_DUMPABLE = 0`: closes `/proc/<pid>/{environ,mem,maps,fd}` and `ptrace` to every other
/// non-root process (the same uid included), so a tenant process that has not escalated cannot
/// read `ZS_SANDBOX_TOKEN` or the deployment-wide `ZS_BYPASS_SECRET` out of the supervisor.
/// Children get a fresh flag on `execve`, so nothing spawned by the agent is affected. Defence in
/// depth only: the image grants passwordless `sudo`, and root reads everything.
#[cfg(target_os = "linux")]
fn harden_process() {
    if let Err(error) = nix::sys::prctl::set_dumpable(false) {
        eprintln!("zs-agent: PR_SET_DUMPABLE failed: {error}");
    }
}

#[cfg(not(target_os = "linux"))]
fn harden_process() {}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> ExitCode {
    harden_process();
    let cli = Cli::parse();
    // `start`, `resume` and `prebuild` install the subscriber themselves once the log shipper
    // exists, so their own `tracing` events reach the control plane (§3.6); every other
    // subcommand only needs stderr.
    if !matches!(
        cli.command,
        Command::Start(_) | Command::Resume | Command::Prebuild
    ) {
        logs::init_tracing(None);
    }
    match run(cli).await {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            tracing::error!(error = %error, "zs-agent failed");
            eprintln!("zs-agent: {error:#}");
            ExitCode::from(exit_code_for(&error))
        }
    }
}

async fn run(cli: Cli) -> anyhow::Result<u8> {
    match cli.command {
        Command::Start(args) => {
            let mut config = load_config()?;
            if args.local {
                config.local = true;
                zs_agent::ports::lsof::force_enabled();
            }
            start::run(args, config).await?;
            Ok(EXIT_OK)
        }
        Command::Resume => {
            start::run(
                StartArgs {
                    resumed: true,
                    ..StartArgs::default()
                },
                load_config()?,
            )
            .await?;
            Ok(EXIT_OK)
        }
        Command::Prebuild => {
            start::run_prebuild(load_config()?).await?;
            Ok(EXIT_OK)
        }
        Command::Credential {
            operation,
            supervisor_url,
            control_secret_file,
        } => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/vercel"));
            let secret =
                credential::read_control_secret_file(control_secret_file.as_deref(), &home);
            let code = credential::main(&operation, &supervisor_url, secret).await?;
            Ok(u8::try_from(code).unwrap_or(EXIT_GENERIC))
        }
        Command::Proxy(args) => {
            proxy::run_standalone(args).await?;
            Ok(EXIT_OK)
        }
        Command::Stop { timeout_secs } => {
            start::stop(&load_config()?, Duration::from_secs(timeout_secs)).await?;
            Ok(EXIT_OK)
        }
        Command::WaitReady {
            timeout_secs,
            allow_degraded,
        } => {
            let ready = start::wait_ready(
                &load_config()?,
                Duration::from_secs(timeout_secs),
                allow_degraded,
            )
            .await?;
            Ok(if ready { EXIT_OK } else { EXIT_GENERIC })
        }
        Command::PortToken {
            secret_b64,
            secret_file,
            workspace_id,
            port,
            ttl_secs,
            sub,
        } => {
            let secret_b64 = match (secret_b64, secret_file) {
                (Some(secret), _) => secret,
                (None, Some(path)) => std::fs::read_to_string(&path)
                    .map_err(|error| anyhow!("{}: {error}", path.display()))?,
                (None, None) => bail!("--secret-b64 or --secret-file is required"),
            };
            let key = decode_secret(&secret_b64).map_err(|error| anyhow!("secret: {error}"))?;
            let now = logs::now_ms() / 1000;
            let mut jti = [0u8; 16];
            rand::rng().fill_bytes(&mut jti);
            let token = PortTokenCodec::new(key).sign(&PortSession {
                ws: workspace_id,
                port,
                sub,
                iat: now,
                exp: now + ttl_secs,
                jti: hex::encode(jti),
            });
            println!("{token}");
            Ok(EXIT_OK)
        }
        Command::Warm(args) => {
            let outcome = warm::run_standalone(args).await?;
            println!(
                "servers_seen={} files_opened={} elapsed_secs={} settled={}",
                outcome.servers_seen.len(),
                outcome.files_opened,
                outcome.elapsed.as_secs(),
                outcome.settled
            );
            Ok(EXIT_OK)
        }
        Command::Version => {
            let build = std::env::var("ZS_BUILD_ID").unwrap_or_else(|_| "dev".to_string());
            println!("zs-agent {} build {build}", env!("CARGO_PKG_VERSION"));
            let server_bin =
                std::env::var("ZS_SERVER_BIN").unwrap_or_else(|_| DEFAULT_SERVER_BIN.to_string());
            match tokio::process::Command::new(&server_bin)
                .arg("version")
                .output()
                .await
            {
                Ok(output) if output.status.success() => {
                    print!("{}", String::from_utf8_lossy(&output.stdout));
                }
                Ok(output) => eprintln!("{server_bin} version exited with {}", output.status),
                Err(error) => eprintln!("{server_bin}: {error}"),
            }
            Ok(EXIT_OK)
        }
    }
}

fn load_config() -> anyhow::Result<Config> {
    Config::from_env().map_err(|error| BootError::Config(error.to_string()).into())
}

fn exit_code_for(error: &anyhow::Error) -> u8 {
    if let Some(boot) = error.downcast_ref::<BootError>() {
        return boot.exit_code();
    }
    if error.downcast_ref::<ConfigError>().is_some() {
        return EXIT_CONFIG;
    }
    EXIT_GENERIC
}
