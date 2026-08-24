/**
 * A dependency the record specifies and the build does not use, or the reverse.
 *
 * The judgement encoded: the stack a project SAYS it uses and the stack it
 * declares in its build file drift apart quietly, and the drift is a real
 * finding rather than a documentation nit - it is the record and the tree
 * disagreeing about what the thing is made of.
 *
 * Grep-class on purpose. Reading a manifest for declared dependency names is a
 * text question, and #5 refuses to push text questions through a parse tree.
 */
import type { Candidate, Probe } from "../types.js";
import { declaredManifests } from "../manifests.js";
import { findReadme } from "../../harvest/tree.js";

/**
 * Technologies a README claims, from a small vocabulary worth being wrong about.
 *
 * One technology per entry, carrying every spelling it goes by. Membership is a
 * substring test, so overlapping spellings in a flat list double-count: a README
 * saying "PostgreSQL" satisfies BOTH "postgres" (a substring of it) and
 * "postgresql", and the probe would emit two divergence edges for one
 * technology. Grouping the aliases means at most one candidate per technology,
 * and the group governs BOTH sides - a README mention and a manifest declaration
 * are the same technology however either spells it, so a dependency declared as
 * `postgresql` also satisfies a README that says `postgres`.
 */
const CLAIMED: { tech: string; aliases: string[] }[] = [
  { tech: "postgres", aliases: ["postgresql", "postgres", "psycopg2", "psycopg", "asyncpg"] },
  { tech: "mysql", aliases: ["mysql", "mysqlclient", "pymysql"] },
  { tech: "sqlite", aliases: ["sqlite"] },
  { tech: "redis", aliases: ["redis"] },
  { tech: "kafka", aliases: ["kafka"] },
  { tech: "rabbitmq", aliases: ["rabbitmq"] },
  { tech: "mongodb", aliases: ["mongodb", "pymongo", "motor"] },
  { tech: "elasticsearch", aliases: ["elasticsearch"] },
  { tech: "docker", aliases: ["docker"] },
  { tech: "testcontainers", aliases: ["testcontainers"] },
  { tech: "flyway", aliases: ["flyway"] },
  { tech: "liquibase", aliases: ["liquibase"] },
];

export const dependencyDivergence: Probe = {
  id: "dependency-divergence",
  finds: "a technology the record names that the build file does not declare",
  toolchain: "any",
  run: (ctx) => {
    const readmePath = findReadme(ctx.paths);
    const readme = readmePath ? ctx.read(readmePath) : null;
    if (readmePath === undefined || readme === null) return [];
    const lower = readme.toLowerCase();

    const manifests = declaredManifests(ctx);
    if (manifests.length === 0) return [];
    const names = new Set<string>();
    for (const m of manifests) if (m.recognized) for (const n of m.names) names.add(n);
    const anyUnrecognized = manifests.some((m) => !m.recognized);
    // With no readable manifest declaring anything, there is no build to diverge
    // from. But an UNREADABLE manifest is not the same as an empty one: emit the
    // candidate and let the gate demote it to unresolved rather than confirm a
    // divergence against a manifest nothing here could parse.
    if (names.size === 0 && !anyUnrecognized) return [];

    const out: Candidate[] = [];
    for (const { tech, aliases } of CLAIMED) {
      if (!aliases.some((a) => lower.includes(a))) continue;
      if ([...names].some((n) => aliases.some((a) => n.includes(a)))) continue;
      out.push({
        probe_id: "dependency-divergence",
        claims: [
          {
            description: `${tech} is named in the README but declared in no build manifest`,
            expect: "absent",
            declares: aliases,
          },
        ],
        node: {
          type: "edge",
          kind: "divergence",
          id: `e-divergence-${tech}`,
          title: `The record names ${tech}; the build file does not declare it`,
          statement: `${readmePath} refers to ${tech}, but no build manifest in the tree declares a dependency on it.`,
          why_it_matters:
            "The stack a project says it uses and the stack it declares drift apart quietly, and the drift is what a reviewer finds first.",
          how_to_say_it: `The README still mentions ${tech}; the build no longer depends on it.`,
          evidence: [{ kind: "file", path: readmePath, sha: ctx.sha }],
          confidence: "verified",
          interview_value: 0,
          probe_id: "dependency-divergence",
        },
      });
    }
    return out;
  },
};
