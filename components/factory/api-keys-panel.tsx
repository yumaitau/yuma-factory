"use client";

import { useState, useTransition } from "react";

import { createApiKeyAction, revokeApiKeyAction } from "@/app/actions/api-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ApiKeyRow = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; expiresAt: string; expired: boolean; revokedAt: string | null };

export function ApiKeysPanel({ keys, mcpUrl }: { keys: ApiKeyRow[]; mcpUrl: string }) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const config = created ? JSON.stringify({ mcpServers: { factory: { type: "http", url: mcpUrl,
    headers: { Authorization: `Bearer ${created.key}` } } } }, null, 2) : "";

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-1 text-lg font-semibold">New key</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          A key acts as you over the HTTP API and MCP: it can start, stop and prompt runs, move and retry tasks, and accept and merge reviews.
          Give each agent or tool its own key so you can revoke it alone. Keys expire after 90 days.
        </p>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          action={() => startTransition(async () => {
            setError(null);
            const result = await createApiKeyAction(name);
            if ("error" in result) setError(result.error ?? "Could not create a key.");
            else { setCreated({ key: result.key, name: result.name }); setName(""); }
          })}
        >
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="key-name">Name</Label>
            <Input id="key-name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Claude Code on my laptop" />
          </div>
          <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create key"}</Button>
        </form>
        {error && <p role="alert" className="mt-3 text-sm text-status-attention">{error}</p>}
        {created && (
          <div className="mt-4 rounded-md border border-border bg-muted p-3 text-sm">
            <p className="mb-2 font-medium">Copy “{created.name}” now. It is not shown again.</p>
            <code className="block break-all rounded bg-background p-2 font-mono text-xs">{created.key}</code>
            <p className="mb-1 mt-3 font-medium">MCP client configuration</p>
            <pre className="overflow-x-auto rounded bg-background p-2 font-mono text-xs">{config}</pre>
          </div>
        )}
      </Card>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Your keys</h2>
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No keys yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {keys.map((key) => (
              <li key={key.id}>
                <Card className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{key.name}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono">{key.prefix}…</span> · created {key.createdAt}
                      {key.lastUsedAt ? ` · last used ${key.lastUsedAt}` : " · never used"}
                      {key.revokedAt ? ` · revoked ${key.revokedAt}` : key.expired ? ` · expired ${key.expiresAt}` : ` · expires ${key.expiresAt}`}
                    </p>
                  </div>
                  {!key.revokedAt && !key.expired && (
                    <Button variant="outline" size="sm" disabled={pending}
                      onClick={() => startTransition(async () => {
                        setError(null);
                        const result = await revokeApiKeyAction(key.id);
                        if ("error" in result) setError(result.error ?? "Could not revoke this key.");
                      })}>
                      Revoke
                    </Button>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
