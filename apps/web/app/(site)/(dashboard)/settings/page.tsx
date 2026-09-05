import { saveDotfilesAction, saveSettingsDocAction } from "../actions";
import { ActionForm } from "../_components/action-form";
import { Card, Field, FIELD_CLASS, PageHeader } from "../_components/ui";
import { dashboardViewer, settingsPageData } from "../data";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { viewer } = await dashboardViewer();
  const { settings, keymap, dotfiles } = await settingsPageData(viewer);
  return <div className="space-y-6">
    <PageHeader title="Settings" description="Shared settings for every workspace. Editor changes sync here too." />
    {(["settings", "keymap"] as const).map((kind) => {
      const doc = kind === "settings" ? settings : keymap;
      return <Card key={kind} title={`${kind}.json`} description={`Version ${doc.version}. Stale edits report a conflict.`}>
        <ActionForm action={saveSettingsDocAction} fields={{ kind, version: doc.version }} submitLabel={`Save ${kind}.json`}>
          <Field label={`${kind}.json`} htmlFor={`${kind}-content`}>
            <textarea id={`${kind}-content`} name="content" rows={14} spellCheck={false}
              className={`${FIELD_CLASS} font-mono text-xs`} defaultValue={doc.content} />
          </Field>
        </ActionForm>
      </Card>;
    })}
    <Card title="Dotfiles" description="A public repository cloned at boot; its install command runs in the sandbox.">
      <ActionForm action={saveDotfilesAction} submitLabel="Save dotfiles">
        <Field label="Repository URL" htmlFor="dotfiles-url" hint="Leave empty to disable.">
          <input id="dotfiles-url" name="repoUrl" type="url" className={FIELD_CLASS}
            defaultValue={dotfiles.repoUrl ?? ""} placeholder="https://github.com/you/dotfiles" />
        </Field>
        <Field label="Install command" htmlFor="dotfiles-command">
          <input id="dotfiles-command" name="installCommand" className={FIELD_CLASS}
            defaultValue={dotfiles.installCommand ?? ""} placeholder="./install.sh" maxLength={1024} />
        </Field>
      </ActionForm>
    </Card>
  </div>;
}
