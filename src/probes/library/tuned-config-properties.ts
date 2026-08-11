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
      // A setting is the unit of finding, not a comment line: one setting
      // introduced by a multi-line rationale is one tuning, however many lines
      // explain it. Iterating over settings (rather than over tuned comments,
      // which double-emits when a block of comment lines all resolve to the same
      // setting) collapses the block by construction. The occurrence ordinal is
      // the semantic discriminator that keeps ids unique when the SAME setting
      // name is tuned at two DISTINCT places in one file - it may separate only
      // genuinely distinct findings, never the same finding discovered twice, or
      // the run-level uniqueness guard reads green on a duplicate the ordinal hid.
      const seen = new Map<string, number>();

      for (const [index, line] of lines.entries()) {
        const setting = SETTING.exec(line);
        if (!setting) continue;
        // The rationale is the contiguous comment block immediately above the
        // setting, gathered outermost-first; blanks within it do not break it,
        // mirroring the record's own layout.
        const rationale: string[] = [];
        let first = index;
        for (let above = index - 1; above >= 0; above -= 1) {
          const commented = COMMENT.exec(lines[above]!)?.[1];
          if (commented !== undefined) {
            rationale.unshift(commented.trim());
            first = above;
          } else if (lines[above]!.trim() === "") {
            continue;
          } else {
            break;
          }
        }
        if (!rationale.some((c) => TUNED.test(c))) continue;

        const key = setting[1]!.replace(/\W+/g, "-");
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);

        out.push({
          probe_id: "tuned-config-properties",
          node: {
            type: "fact",
            id: `f-tuned-${pathSlug(path)}-${key}-${occurrence}`,
            label: setting[1]!,
            value: setting[2]!,
            source: "file",
            title: `${setting[1]} was tuned, not guessed`,
            evidence: [
              { kind: "file", path, line_start: first + 1, line_end: index + 1, sha: ctx.sha, note: rationale.join(" ") },
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
