import { DEFAULT_TEAM_MEMBER_LIMIT } from "@openbot/contracts/input-limits";
import type { ServerSummary } from "@openbot/contracts/ipc";
import { Heading, Text } from "@openbot/ui";
import { AddServerDialog, type HostedServerSetupStatus } from "@openbot/ui/features/servers/AddServerDialog";
import type { HostedServerPlan } from "@openbot/ui/features/servers/HostedServerPricing";
import { ServerRail } from "@openbot/ui/features/servers/ServerRail";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_SERVERS } from "./fixtures";

/**
 * Draft prices for design review. The machine sizes, speed factors and member limits are not
 * final. Starter has the default member limit of every host. Each price divides by 5, so the
 * yearly price (20% less) is a whole number.
 */
const PLANS: HostedServerPlan[] = [
  {
    id: "starter",
    monthlyPrice: { EUR: 20, USD: 25, PLN: 90 },
    diskGb: 12,
    memberLimit: DEFAULT_TEAM_MEMBER_LIMIT,
    relativeSpeed: 1,
  },
  { id: "standard", monthlyPrice: { EUR: 50, USD: 60, PLN: 220 }, diskGb: 50, memberLimit: 10, relativeSpeed: 2 },
  { id: "pro", monthlyPrice: { EUR: 100, USD: 120, PLN: 440 }, diskGb: 100, memberLimit: 25, relativeSpeed: 4 },
];

/** How long each fake setup step takes, so the progress is easy to watch. */
const STEP_MS = 5_000;

interface FlowProps {
  /** Open the add-server dialog when the story loads. */
  startOpen?: boolean;
  /** The fake setup stops with an error at the "Start OpenBot" step on the first try. */
  failFirstTry?: boolean;
}

/**
 * The server rail with a working plus button. Create a hosted server; the new server is added to
 * the rail. Nothing leaves the browser: every call is fake.
 */
function AddServerFlow(props: FlowProps) {
  const [servers, setServers] = createSignal<ServerSummary[]>(STORY_SERVERS);
  const [addOpen, setAddOpen] = createSignal(props.startOpen ?? false);
  const [contactNote, setContactNote] = createSignal(false);
  const [setupStatus, setSetupStatus] = createSignal<HostedServerSetupStatus | null>(null);
  const [pending, setPending] = createSignal({ id: "", name: "" });
  let attempts = 0;
  let timers: number[] = [];

  const activeServer = createMemo(() => servers().find((server) => server.active) ?? servers()[0]);

  onCleanup(clearTimers);

  function clearTimers(): void {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  }

  function runSetup(): void {
    clearTimers();
    attempts += 1;
    const fail = props.failFirstTry && attempts === 1;
    setSetupStatus("creating");
    const steps: HostedServerSetupStatus[] = fail ? ["starting", "error"] : ["starting", "connecting", "ready"];
    timers = steps.map((status, index) => window.setTimeout(() => setSetupStatus(status), STEP_MS * (index + 1)));
  }

  function openAdd(): void {
    clearTimers();
    attempts = 0;
    setSetupStatus(null);
    setAddOpen(true);
  }

  function addServer(server: Omit<ServerSummary, "active">): void {
    setServers((current) => [...current.map((entry) => ({ ...entry, active: false })), { ...server, active: true }]);
  }

  return (
    <>
      <ServerRail
        servers={servers()}
        onSelect={(serverId) =>
          setServers((current) => current.map((server) => ({ ...server, active: server.id === serverId })))
        }
        onReorder={(serverIds) =>
          setServers((current) => [
            ...current.filter((server) => server.kind === "local"),
            ...serverIds.flatMap((id) => current.filter((server) => server.id === id)),
          ])
        }
        onAdd={openAdd}
      />
      <main class="foundation-story">
        <Heading as="h1" size="lg">
          {activeServer()?.name}
        </Heading>
        <Text tone="muted">Click the plus button in the server rail to add a server.</Text>
        <Show when={contactNote()}>
          <Text tone="muted">"Contact us" was clicked. The app opens its contact page here.</Text>
        </Show>
      </main>

      <Show when={addOpen()}>
        <AddServerDialog
          plans={PLANS}
          recommendedPlan="standard"
          setupStatus={setupStatus()}
          onClose={() => setAddOpen(false)}
          onContactUs={() => setContactNote(true)}
          onCreate={async () => {
            await new Promise((resolve) => window.setTimeout(resolve, 700));
            const count = servers().filter((server) => server.id.startsWith("hosted-")).length;
            const id = `hosted-${count + 1}`;
            const name = count === 0 ? "Cloud server" : `Cloud server ${count + 1}`;
            setPending({ id, name });
            runSetup();
            return { serverId: id, name };
          }}
          onRetry={runSetup}
          onOpenServer={() =>
            addServer({
              ...serverDefaults(),
              id: pending().id,
              name: pending().name,
              apiUrl: `https://${pending().id}.hosted.openbot.run`,
              role: "owner",
            })
          }
        />
      </Show>
    </>
  );
}

function serverDefaults(): Omit<ServerSummary, "active" | "id" | "name" | "apiUrl" | "role"> {
  return {
    logoUrl: null,
    notificationsMuted: false,
    notificationsMutedUntil: null,
    notificationLevel: "all",
    kind: "remote",
    state: "online",
    remoteDesktopAvailable: true,
  };
}

const meta = {
  title: "Team/Add Server Flow",
  decorators: [(Story) => <div class="app-frame app-frame-edge app-frame-with-server-rail">{Story()}</div>],
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    viewport: {
      options: {
        addServerNarrow: { name: "Add server — 360 × 720", styles: { width: "360px", height: "720px" } },
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Click the plus button, then create a hosted server. */
export const ClickPlus: Story = {
  render: () => <AddServerFlow />,
};

/** The dialog is open when the story loads. */
export const DialogOpen: Story = {
  render: () => <AddServerFlow startOpen />,
};

/** The first setup stops at "Start OpenBot". "Try again" then succeeds. */
export const SetupFails: Story = {
  render: () => <AddServerFlow startOpen failFirstTry />,
};

/** A narrow window: the plan cards stack. */
export const Narrow: Story = {
  globals: { viewport: { value: "addServerNarrow", isRotated: false } },
  render: () => <AddServerFlow startOpen />,
};
