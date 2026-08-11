/**
 * A configuration property documented as tuned rather than chosen.
 *
 * The judgement encoded: a number with a comment explaining how it was arrived
 * at is a decision with its reasoning attached, sitting in a config file where
 * no decision record would look for it. "Measured", "empirically", "tuned",
 * "found that" - those words mark a value someone earned rather than guessed,
 * and they are the cheapest decision records in any repository.
 *
 * Grep-class: this is entirely a question about what a comment says.
 */
import type { Candidate, Probe } from "../types.js";
import { pathSlug } from "../id.js";

const CONFIG = /\.(ya?ml|properties|toml|ini|conf|json)$/i;
const TUNED = /\b(empiric|measured|measurement|tuned|benchmark|profil|observed|found that|in practice|by experiment)\w*\b/i;
const COMMENT = /^\s*[#/]{1,2}\s*(.+)$/;
const SETTING = /^\s*([\w.-]+)\s*[:=]\s*(.+?)\s*$/;

export const tunedConfigProperties: Probe = {
  id: "tuned-config-properties",
  finds: "a configuration value documented as measured rather than chosen",
  toolchain: "any",
  run: (ctx) => {
    const out: Candidate[] = [];
    for (const path of ctx.paths.filter((p) => CONFIG.test(p))) {
      const source = ctx.read(path);
      if (source === null || !TUNED.test(source)) continue;
      const lines = source.split("\n");

      for (const [index, line] of lines.entries()) {
        const comment = COMMENT.exec(line)?.[1];
        if (comment === undefined || !TUNED.test(comment)) continue;
        // The setting the note is about is the next non-blank, non-comment line.
        let target = index + 1;
        while (target < lines.length && (lines[target]!.trim() === "" || COMMENT.test(lines[target]!))) {
          target += 1;
        }
        const setting = target < lines.length ? SETTING.exec(lines[target]!) : null;
        if (!setting) continue;

        out.push({
          probe_id: "tuned-config-properties",
          node: {
            type: "fact",
            id: `f-tuned-${pathSlug(path)}-${setting[1]!.replace(/\W+/g, "-")}`,
            label: setting[1]!,
            value: setting[2]!,
            source: "file",
            title: `${setting[1]} was tuned, not guessed`,
            evidence: [
              { kind: "file", path, line_start: index + 1, line_end: target + 1, sha: ctx.sha, note: comment.trim() },
            ],
            confidence: "verified",
            interview_value: 0,
            probe_id: "tuned-config-properties",
          },
        });
      }
    }
    return out;
  },
};
