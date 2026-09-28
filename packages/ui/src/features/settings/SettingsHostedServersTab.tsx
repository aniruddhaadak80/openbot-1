import {
  HOSTED_SERVER_NAME_MAX_LENGTH,
  HOSTED_SERVER_SIZE_NAMES,
  HOSTED_SERVER_SIZES,
  type HostedServerSize,
  type HostedServerState,
} from "@openbot/contracts/hosted-servers";
import type { AppTextKey } from "@openbot/i18n";
import {
  Badge,
  type BadgeTone,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  Text,
  Trash2,
} from "@openbot/ui";
import { For, Show } from "solid-js";
import { useText } from "../../text";
import type { SettingsHostedServersStore } from "./stores/hosted-servers-store";

interface SettingsHostedServersTabProps {
  store: SettingsHostedServersStore;
  /** The dialog element the size popover portals into, as the other Settings selects receive it. */
  selectMount?: HTMLElement | undefined;
}

/** Kobalte takes a mutable array. */
const sizeOptions: HostedServerSize[] = [...HOSTED_SERVER_SIZE_NAMES];

const STATE_LABELS = {
  creating: "settings.hostedServers.state.creating",
  starting: "settings.hostedServers.state.starting",
  running: "settings.hostedServers.state.running",
  stopping: "settings.hostedServers.state.stopping",
  stopped: "settings.hostedServers.state.stopped",
  waking: "settings.hostedServers.state.waking",
  error: "settings.hostedServers.state.error",
  deleted: "settings.hostedServers.state.deleted",
} as const satisfies Record<HostedServerState, AppTextKey>;

const STATE_TONES: Record<HostedServerState, BadgeTone> = {
  creating: "accent",
  starting: "accent",
  running: "success",
  stopping: "neutral",
  stopped: "neutral",
  waking: "accent",
  error: "danger",
  deleted: "neutral",
};

export function SettingsHostedServersTab(props: SettingsHostedServersTabProps) {
  const { t } = useText();
  const state = () => props.store.state;
  const sizeLabel = (size: HostedServerSize) =>
    t(size === "small" ? "settings.hostedServers.size.small" : "settings.hostedServers.size.default", {
      vcpu: HOSTED_SERVER_SIZES[size].vcpu,
      memory: HOSTED_SERVER_SIZES[size].memoryGb,
      disk: HOSTED_SERVER_SIZES[size].diskGb,
    });

  return (
    <SettingsSection title={t("settings.hostedServers.title")} description={t("settings.hostedServers.description")}>
      <form
        class="hosted-servers-create"
        onSubmit={(event) => {
          event.preventDefault();
          void props.store.create();
        }}
      >
        <Field label={t("settings.hostedServers.nameLabel")} error={state().createError ?? undefined}>
          <Input
            value={state().draftName}
            maxlength={HOSTED_SERVER_NAME_MAX_LENGTH}
            autocomplete="off"
            placeholder={t("settings.hostedServers.namePlaceholder")}
            disabled={state().creating}
            onValueChange={props.store.setDraftName}
          />
        </Field>
        <Select<HostedServerSize>
          class="settings-modal-select"
          options={sizeOptions}
          value={state().draftSize}
          disabled={state().creating}
          onChange={(size) => size && props.store.setDraftSize(size)}
          placement="bottom-start"
          itemComponent={(itemProps) => (
            <SelectItem item={itemProps.item}>{sizeLabel(itemProps.item.rawValue)}</SelectItem>
          )}
        >
          <SelectTrigger size="md" aria-label={t("settings.hostedServers.sizeLabel")}>
            <SelectValue<HostedServerSize>>{(select) => sizeLabel(select.selectedOption())}</SelectValue>
          </SelectTrigger>
          <SelectContent mount={props.selectMount} />
        </Select>
        <Button type="submit" disabled={state().creating || !state().draftName.trim()}>
          <Plus size={14} aria-hidden="true" />
          {state().creating ? t("settings.hostedServers.creating") : t("settings.hostedServers.create")}
        </Button>
      </form>
      <Text tone="muted" variant="caption">
        {t("settings.hostedServers.alwaysOnNote")}
      </Text>

      <Show when={state().error}>{(message) => <p class="settings-modal-error">{message()}</p>}</Show>
      <Show
        when={state().servers.length > 0}
        fallback={
          <Show when={state().loaded}>
            <Text tone="muted">{t("settings.hostedServers.empty")}</Text>
          </Show>
        }
      >
        <ItemGroup class="settings-modal-card hosted-servers-list" surface="subtle">
          <For each={state().servers}>
            {(server) => (
              <Item class="hosted-servers-row">
                <ItemContent>
                  <ItemTitle>
                    {server.name}
                    <Badge tone={STATE_TONES[server.state]}>{t(STATE_LABELS[server.state])}</Badge>
                  </ItemTitle>
                  <ItemDescription>
                    {server.state === "error" ? t("settings.hostedServers.errorDescription") : sizeLabel(server.size)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions class="hosted-servers-actions">
                  <Show when={server.state === "stopped" || server.state === "error"}>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("settings.hostedServers.wakeLabel", { name: server.name })}
                      disabled={state().wakingServerId !== null}
                      onClick={() => void props.store.wake(server)}
                    >
                      {state().wakingServerId === server.serverId
                        ? t("settings.hostedServers.waking")
                        : t("settings.hostedServers.wake")}
                    </Button>
                  </Show>
                  <Button
                    variant="destructive-ghost"
                    size="sm"
                    aria-label={t("settings.hostedServers.deleteLabel", { name: server.name })}
                    disabled={state().deleting}
                    onClick={() => props.store.requestDelete(server)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    {t("common.delete")}
                  </Button>
                </ItemActions>
              </Item>
            )}
          </For>
        </ItemGroup>
      </Show>

      <ConfirmDialog
        open={state().pendingDelete !== null}
        title={t("settings.hostedServers.deleteTitle", { name: state().pendingDelete?.name ?? "" })}
        description={t("settings.hostedServers.deleteDescription")}
        confirmLabel={t("common.delete")}
        pendingLabel={t("settings.hostedServers.deleting")}
        pending={state().deleting}
        error={state().deleteError ?? undefined}
        initialFocus="cancel"
        onCancel={props.store.cancelDelete}
        onConfirm={props.store.confirmDelete}
      >
        <Field label={t("settings.hostedServers.deleteConfirmLabel", { name: state().pendingDelete?.name ?? "" })}>
          <Input
            value={state().deleteConfirmName}
            autocomplete="off"
            spellcheck={false}
            disabled={state().deleting}
            onValueChange={props.store.setDeleteConfirmName}
          />
        </Field>
      </ConfirmDialog>
    </SettingsSection>
  );
}
