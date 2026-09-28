import { isBoolean, isDynamicRecord, isOneOf, isString } from "./runtime-values";

/** The machine sizes that a user can select. The account server maps each size to a provider type. */
export const HOSTED_SERVER_SIZES = {
  small: { vcpu: 2, memoryGb: 4, diskGb: 12 },
  default: { vcpu: 4, memoryGb: 8, diskGb: 50 },
} as const;

export type HostedServerSize = keyof typeof HOSTED_SERVER_SIZES;

export const HOSTED_SERVER_SIZE_NAMES = ["small", "default"] as const satisfies readonly HostedServerSize[];

export const DEFAULT_HOSTED_SERVER_SIZE: HostedServerSize = "small";

export const HOSTED_SERVER_STATES = [
  "creating",
  "starting",
  "running",
  "stopping",
  "stopped",
  "waking",
  "error",
  "deleted",
] as const;

export type HostedServerState = (typeof HOSTED_SERVER_STATES)[number];

/** The reason codes for a server in the error state. They never contain provider text. */
export const HOSTED_SERVER_ERRORS = ["provider_error", "provider_billing", "provider_limit", "start_failed"] as const;

export type HostedServerError = (typeof HOSTED_SERVER_ERRORS)[number];

export const HOSTED_SERVER_NAME_MAX_LENGTH = 80;

export interface HostedServerSummary {
  /** The same value as the Remote host id of the server. */
  serverId: string;
  name: string;
  size: HostedServerSize;
  state: HostedServerState;
  error: HostedServerError | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostedServerList {
  /** False when this account cannot create hosted servers. */
  available: boolean;
  servers: HostedServerSummary[];
}

export interface HostedServerClaim {
  hostId: string;
  name: string;
  sessionToken: string;
  user: { id: string; email: string; name: string | null; avatarUrl: string | null };
}

export function isHostedServerSize(value: unknown): value is HostedServerSize {
  return isOneOf(HOSTED_SERVER_SIZE_NAMES, value);
}

export function isHostedServerState(value: unknown): value is HostedServerState {
  return isOneOf(HOSTED_SERVER_STATES, value);
}

/** Returns null for a value that is not a hosted server summary. */
export function parseHostedServerSummary(value: unknown): HostedServerSummary | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.serverId) ||
    !isString(value.name) ||
    !isHostedServerSize(value.size) ||
    !isHostedServerState(value.state) ||
    !(value.error === null || isOneOf(HOSTED_SERVER_ERRORS, value.error)) ||
    !isString(value.createdAt) ||
    !isString(value.updatedAt)
  ) {
    return null;
  }
  return {
    serverId: value.serverId,
    name: value.name,
    size: value.size,
    state: value.state,
    error: value.error,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** Returns null for a value that is not a hosted server list. */
export function parseHostedServerList(value: unknown): HostedServerList | null {
  if (!isDynamicRecord(value) || !isBoolean(value.available) || !Array.isArray(value.servers)) return null;
  const servers: HostedServerSummary[] = [];
  for (const entry of value.servers) {
    const server = parseHostedServerSummary(entry);
    if (!server) return null;
    servers.push(server);
  }
  return { available: value.available, servers };
}

/** Returns null for a value that is not a redeemed claim. */
export function parseHostedServerClaim(value: unknown): HostedServerClaim | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.hostId) ||
    !isString(value.name) ||
    !isString(value.sessionToken) ||
    !isDynamicRecord(value.user)
  ) {
    return null;
  }
  const user = value.user;
  if (
    !isString(user.id) ||
    !isString(user.email) ||
    !(user.name === null || isString(user.name)) ||
    !(user.avatarUrl === null || isString(user.avatarUrl))
  ) {
    return null;
  }
  return {
    hostId: value.hostId,
    name: value.name,
    sessionToken: value.sessionToken,
    user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
  };
}

export interface CreateHostedServerInput {
  name: string;
  size: HostedServerSize;
  /** One ID for each opened create form, so a repeated submit does not create a second server. */
  requestId: string;
}

export interface DeleteHostedServerInput {
  serverId: string;
  /** The server name as the user typed it. The account server compares it to the stored name. */
  confirmName: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;

/** Returns null for a value that is not a valid create request. */
export function parseCreateHostedServerInput(value: unknown): CreateHostedServerInput | null {
  if (!isDynamicRecord(value) || !isString(value.name) || !isHostedServerSize(value.size)) return null;
  const name = value.name.trim();
  if (!name || name.length > HOSTED_SERVER_NAME_MAX_LENGTH || /\p{Cc}/u.test(name)) return null;
  if (!isString(value.requestId) || !REQUEST_ID_PATTERN.test(value.requestId)) return null;
  return { name, size: value.size, requestId: value.requestId };
}

/** Returns null for a value that is not a valid delete request. */
export function parseDeleteHostedServerInput(value: unknown): DeleteHostedServerInput | null {
  if (!isDynamicRecord(value) || !isString(value.serverId) || !isString(value.confirmName)) return null;
  if (!value.serverId || value.confirmName.length > HOSTED_SERVER_NAME_MAX_LENGTH) return null;
  return { serverId: value.serverId, confirmName: value.confirmName };
}
