use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};

use zs_agent::config::{Config, ConfigError, DEFAULT_SERVER_BIN};
use zs_agent::logs;
use zs_agent::start::{self, BootError, EXIT_CONFIG, EXIT_GENERIC, EXIT_OK, StartArgs};

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
    if !matches!(cli.command, Command::Start(_) | Command::Resume) {
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
