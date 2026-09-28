import {
  DEFAULT_HOSTED_SERVER_SIZE,
  type HostedServerSize,
  type HostedServerState,
  type HostedServerSummary,
} from "@openbot/contracts/hosted-servers";
import type { HostedServersDesktopApi } from "@openbot/contracts/ipc";
import { createEffect, createStore, untrack } from "solid-js";
import { currentText } from "../../../text";

/** A server in one of these states changes without a user action, so the list polls while one is shown. */
const TRANSITION_STATES: ReadonlySet<HostedServerState> = new Set(["creating", "starting", "stopping", "waking"]);
const TRANSITION_REFRESH_INTERVAL_MS = 5_000;

interface HostedServersStoreProps {
  open: boolean;
  hostedServersApi?: HostedServersDesktopApi | undefined;
}

interface HostedServersPanel {
  /** False until the account server says that this account can create hosted servers. */
  available: boolean;
  loaded: boolean;
  error: string | null;
  servers: HostedServerSummary[];
  draftName: string;
  draftSize: HostedServerSize;
  creating: boolean;
  createError: string | null;
  wakingServerId: string | null;
  /** The server the confirmation dialog asks about. */
  pendingDelete: HostedServerSummary | null;
  /** The name that the user types to confirm the deletion. */
  deleteConfirmName: string;
  deleting: boolean;
  deleteError: string | null;
}

/**
 * The Hosted servers tab: the server list, the create form, wake, and the delete confirmation.
 * The list loads when the dialog opens, because the tab is shown only when the account can use it.
 */
export function createSettingsHostedServersStore(props: HostedServersStoreProps, isActive: () => boolean) {
  const [panel, setPanel] = createStore<HostedServersPanel>({
    available: false,
    loaded: false,
    error: null,
    servers: [],
    draftName: "",
    draftSize: DEFAULT_HOSTED_SERVER_SIZE,
    creating: false,
    createError: null,
    wakingServerId: null,
    pendingDelete: null,
    deleteConfirmName: "",
    deleting: false,
    deleteError: null,
  });
  /**
   * One key for each server that the user asks for. A retry after a lost response sends the same
   * key, so the account server returns the first server and does not create a second one.
   */
  let requestId = crypto.randomUUID();
  let loadRevision = 0;

  async function load(): Promise<void> {
    const api = props.hostedServersApi;
    if (!api) return;
    const revision = ++loadRevision;
    try {
      const list = await api.list();
      if (revision !== loadRevision) return;
      setPanel((state) => {
        state.available = list.available;
        state.servers = list.servers;
        state.loaded = true;
        state.error = null;
      });
    } catch (error) {
      if (revision !== loadRevision) return;
      setPanel((state) => {
        const text = currentText();
        state.error = text.errorMessage(error, text.t("settings.hostedServers.loadFailed"));
      });
    }
  }

  createEffect(
    () => props.open && Boolean(props.hostedServersApi),
    (shouldLoad) => {
      if (shouldLoad) void untrack(load);
    },
  );

  createEffect(
    () => props.open && isActive() && panel.servers.some((server) => TRANSITION_STATES.has(server.state)),
    (shouldPoll) => {
      if (!shouldPoll) return;
      const timer = window.setInterval(() => void load(), TRANSITION_REFRESH_INTERVAL_MS);
      return () => window.clearInterval(timer);
    },
  );

  function setDraftName(value: string): void {
    setPanel((state) => {
      state.draftName = value;
      state.createError = null;
    });
  }

  function setDraftSize(value: HostedServerSize): void {
    setPanel((state) => {
      state.draftSize = value;
    });
  }

  async function create(): Promise<void> {
    const api = props.hostedServersApi;
    const name = panel.draftName.trim();
    if (!api || !name || panel.creating) return;
    setPanel((state) => {
      state.creating = true;
      state.createError = null;
    });
    try {
      const server = await api.create({ name, size: panel.draftSize, requestId });
      requestId = crypto.randomUUID();
      setPanel((state) => {
        state.servers = [...state.servers.filter((entry) => entry.serverId !== server.serverId), server];
        state.draftName = "";
        state.draftSize = DEFAULT_HOSTED_SERVER_SIZE;
      });
      await load();
    } catch (error) {
      setPanel((state) => {
        const text = currentText();
        state.createError = text.errorMessage(error, text.t("settings.hostedServers.createFailed"));
      });
    } finally {
      setPanel((state) => {
        state.creating = false;
      });
    }
  }

  async function wake(server: HostedServerSummary): Promise<void> {
    const api = props.hostedServersApi;
    if (!api || panel.wakingServerId) return;
    setPanel((state) => {
      state.wakingServerId = server.serverId;
      state.error = null;
    });
    try {
      const woken = await api.wake(server.serverId);
      setPanel((state) => {
        state.servers = state.servers.map((entry) => (entry.serverId === woken.serverId ? woken : entry));
      });
    } catch (error) {
      setPanel((state) => {
        const text = currentText();
        state.error = text.errorMessage(error, text.t("settings.hostedServers.wakeFailed"));
      });
    } finally {
      setPanel((state) => {
        state.wakingServerId = null;
      });
    }
  }

  function requestDelete(server: HostedServerSummary): void {
    if (!props.hostedServersApi || panel.deleting) return;
    setPanel((state) => {
      state.pendingDelete = server;
      state.deleteConfirmName = "";
      state.deleteError = null;
    });
  }

  function setDeleteConfirmName(value: string): void {
    setPanel((state) => {
      state.deleteConfirmName = value;
      state.deleteError = null;
    });
  }

  function cancelDelete(): void {
    if (panel.deleting) return;
    setPanel((state) => {
      state.pendingDelete = null;
      state.deleteConfirmName = "";
      state.deleteError = null;
    });
  }

  const deleteConfirmed = () =>
    panel.pendingDelete !== null && panel.deleteConfirmName.trim() === panel.pendingDelete.name;

  /** Deletes the server the dialog asks about. A failed deletion keeps the dialog open with the error. */
  async function confirmDelete(): Promise<void> {
    const api = props.hostedServersApi;
    const server = panel.pendingDelete;
    if (!api || !server || panel.deleting) return;
    if (!deleteConfirmed()) {
      setPanel((state) => {
        state.deleteError = currentText().t("settings.hostedServers.deleteNameMismatch");
      });
      return;
    }
    setPanel((state) => {
      state.deleting = true;
      state.deleteError = null;
    });
    try {
      await api.delete({ serverId: server.serverId, confirmName: panel.deleteConfirmName.trim() });
      setPanel((state) => {
        state.servers = state.servers.filter((entry) => entry.serverId !== server.serverId);
        state.pendingDelete = null;
        state.deleteConfirmName = "";
      });
      await load();
    } catch (error) {
      setPanel((state) => {
        const text = currentText();
        state.deleteError = text.errorMessage(error, text.t("settings.hostedServers.deleteFailed"));
      });
    } finally {
      setPanel((state) => {
        state.deleting = false;
      });
    }
  }

  return {
    state: panel,
    load,
    setDraftName,
    setDraftSize,
    create,
    wake,
    requestDelete,
    setDeleteConfirmName,
    cancelDelete,
    confirmDelete,
    deleteConfirmed,
  };
}

export type SettingsHostedServersStore = ReturnType<typeof createSettingsHostedServersStore>;
