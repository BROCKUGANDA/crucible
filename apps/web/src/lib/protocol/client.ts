/**
 * @file client.ts — the two calls the console and portal make.
 *
 * One place for the session cookie, the JSON shape and the error mapping, so a
 * page cannot accidentally talk to a different host or render a 403 as a blank
 * table. `stampGet`/`stampPost` return a result object rather than throwing:
 * the pages distinguish "denied" from "failed", and an exception loses that.
 */

import { API_BASE } from "@/lib/apiBase";
import { apiFailure, type ApiErrorBody } from "./console";

export type StampResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string; body: ApiErrorBody | null };

async function call<T>(path: string, init: RequestInit): Promise<StampResult<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: apiFailure(res.status, body as ApiErrorBody | null),
        body: body as ApiErrorBody | null,
      };
    }
    return { ok: true, status: res.status, data: body as T };
  } catch (error) {
    // A transport failure is not a refusal: say so, and do not dress it as one.
    return {
      ok: false,
      status: 0,
      message: `The API could not be reached: ${(error as Error).message}`,
      body: null,
    };
  }
}

export function stampGet<T>(path: string): Promise<StampResult<T>> {
  return call<T>(path, { method: "GET" });
}

export function stampPost<T>(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<StampResult<T>> {
  return call<T>(path, {
    method: "POST",
    headers: extraHeaders,
    body: JSON.stringify(body ?? {}),
  });
}
