import { SERVICE_TOKEN } from "./service-token.js";
import { wreck } from "./wreck.js";

const get = (path, query, token) =>
  wreck.get(query ? `${path}?${new URLSearchParams(query)}` : path, {
    headers: { authorization: token },
  });

// Both boxes in one read: the call the admin surface makes, and since the six
// per-box endpoints were retired the only list call there is.
export const findPage = (query, token = `Bearer ${SERVICE_TOKEN}`) =>
  get("/actuators/events", query, token);

const post = (path, token, payload) =>
  wreck.post(path, {
    headers: { authorization: token },
    ...(payload ? { payload } : {}),
  });

const withActor = (path, by) =>
  by ? `${path}?by=${encodeURIComponent(by)}` : path;

export const getInboxEvent = (id, token = `Bearer ${SERVICE_TOKEN}`) =>
  get(`/actuators/events/inbox/${id}`, undefined, token);

export const getOutboxEvent = (id, token = `Bearer ${SERVICE_TOKEN}`) =>
  get(`/actuators/events/outbox/${id}`, undefined, token);

export const redriveInboxEvent = (
  id,
  { by } = {},
  token = `Bearer ${SERVICE_TOKEN}`,
) => post(withActor(`/actuators/events/inbox/${id}/redrive`, by), token);

export const redriveOutboxEvent = (
  id,
  { by } = {},
  token = `Bearer ${SERVICE_TOKEN}`,
) => post(withActor(`/actuators/events/outbox/${id}/redrive`, by), token);

export const purgeInboxEvent = (
  id,
  { by, ...payload } = {},
  token = `Bearer ${SERVICE_TOKEN}`,
) => post(withActor(`/actuators/events/inbox/${id}/purge`, by), token, payload);

export const purgeOutboxEvent = (
  id,
  { by, ...payload } = {},
  token = `Bearer ${SERVICE_TOKEN}`,
) =>
  post(withActor(`/actuators/events/outbox/${id}/purge`, by), token, payload);
