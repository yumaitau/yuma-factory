"use client";

import { useRef, useTransition } from "react";

import { createAgentAction } from "@/app/actions/factory";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateAgentForm() {
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <Card>
      <h2 className="mb-3 text-lg font-semibold">New agent</h2>
      <form
        ref={formRef}
        action={(formData) =>
          startTransition(async () => {
            await createAgentAction(formData);
            formRef.current?.reset();
          })
        }
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="agent-name">Name</Label>
          <Input
            id="agent-name"
            name="name"
            required
            maxLength={80}
            placeholder="e.g. Triage Bot"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="agent-color">Colour</Label>
          <Input
            id="agent-color"
            name="color"
            type="color"
            defaultValue="#6366f1"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="agent-model">Codex model (optional)</Label>
          <Input
            id="agent-model"
            name="modelId"
            placeholder="Subscription default"
            pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor="agent-prompt">System prompt (optional)</Label>
          <textarea
            id="agent-prompt"
            name="systemPrompt"
            rows={3}
            maxLength={4000}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="How this agent should approach tickets…"
          />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create agent"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
