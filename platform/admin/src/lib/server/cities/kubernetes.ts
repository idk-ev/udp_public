/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { assertFileNames, changes, type Publisher } from "./publisher.ts";

/**
 * Publishes to one ConfigMap through the Kubernetes API, with the pod's own service
 * account. The chart's Role allows get and patch on exactly this ConfigMap. No client
 * library for two requests. node:https instead of fetch: it takes the cluster's CA per
 * request, so nothing else in this process comes to trust it.
 */
export interface KubernetesAnswer {
  status: number;
  body: string;
}

export type KubernetesRequest = (method: "GET" | "PATCH", path: string, body?: string) => Promise<KubernetesAnswer>;

const ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

/** Status and API message only. No headers: one of them is the token. */
function failure(action: string, answer: KubernetesAnswer): Error {
  let message = "";
  try {
    const parsed: unknown = JSON.parse(answer.body);
    if (isRecord(parsed) && typeof parsed.message === "string") message = `: ${parsed.message}`;
  } catch {
    // Not JSON: the status has to do.
  }
  return new Error(`${action}: HTTP ${String(answer.status)}${message}`);
}

function parseData(body: string): ReadonlyMap<string, string> {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) throw new TypeError("ConfigMap answer is not an object");
  const { data } = parsed;
  if (data === undefined || data === null) return new Map();
  if (!isRecord(data)) throw new TypeError("ConfigMap data is not an object");
  const files = new Map<string, string>();
  for (const [name, value] of Object.entries(data)) {
    if (typeof value === "string") files.set(name, value);
  }
  return files;
}

export function createKubernetesPublisher(
  configMap: string,
  request: KubernetesRequest,
  namespace: () => Promise<string>,
): Publisher {
  const path = async (): Promise<string> =>
    `/api/v1/namespaces/${encodeURIComponent(await namespace())}/configmaps/${encodeURIComponent(configMap)}`;
  return {
    async read() {
      const answer = await request("GET", await path());
      if (answer.status !== 200) throw failure(`reading ConfigMap ${configMap}`, answer);
      return parseData(answer.body);
    },
    async write(next, current) {
      assertFileNames(next);
      const { changed, removed } = changes(next, current);
      if (changed.length === 0 && removed.length === 0) return false;
      // JSON merge patch: null removes a key. One API call, so all files change at once.
      const data: Record<string, string | null> = {};
      for (const name of changed) data[name] = next.get(name) ?? "";
      for (const name of removed) data[name] = null;
      const answer = await request("PATCH", await path(), JSON.stringify({ data }));
      if (answer.status !== 200) throw failure(`patching ConfigMap ${configMap}`, answer);
      return true;
    },
  };
}

/** The real transport: API address from the environment, token and CA from the pod. */
export function podRequest(environment: Readonly<Record<string, string | undefined>>): KubernetesRequest {
  return async (method, path, body) => {
    const host = environment.KUBERNETES_SERVICE_HOST;
    const port = environment.KUBERNETES_SERVICE_PORT ?? "443";
    if (host === undefined || host === "") throw new Error("not running in a Kubernetes pod");
    // Read per request: the kubelet rotates the token in place.
    const [token, ca] = await Promise.all([
      readFile(`${ACCOUNT_DIR}/token`, "utf8"),
      readFile(`${ACCOUNT_DIR}/ca.crt`, "utf8"),
    ]);
    return new Promise((resolve, reject) => {
      const outgoing = httpsRequest(
        {
          host,
          port: Number(port),
          method,
          path,
          ca,
          timeout: TIMEOUT_MS,
          headers: {
            Authorization: `Bearer ${token.trim()}`,
            Accept: "application/json",
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/merge-patch+json", "Content-Length": Buffer.byteLength(body) }),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () => {
            resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
          });
          incoming.on("error", reject);
        },
      );
      outgoing.on("timeout", () => {
        outgoing.destroy(new Error("Kubernetes API timeout"));
      });
      outgoing.on("error", reject);
      if (body !== undefined) outgoing.write(body);
      outgoing.end();
    });
  };
}

export async function podNamespace(): Promise<string> {
  return (await readFile(`${ACCOUNT_DIR}/namespace`, "utf8")).trim();
}
