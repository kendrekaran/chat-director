import { createHash } from "node:crypto";
import type { SceneProposal } from "./types.js";

export function proposalHash(proposal: SceneProposal): string {
  const normalized = {
    prompt: proposal.prompt.trim(),
    supportingMessageIds: [...proposal.supportingMessageIds].sort(),
    proposedProgression: {
      summary: proposal.proposedProgression.summary.trim(),
      events: proposal.proposedProgression.events?.map((event) => event.trim()) ?? [],
      characterUpdates: (proposal.proposedProgression.characterUpdates ?? []).map((character) => ({
        name: character.name.trim(),
        description: character.description.trim(),
      })),
    },
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
