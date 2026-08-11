/**
 * The stage register (#2): one subcommand per pipeline stage, in pipeline order.
 *
 * Keeping the register in one place means the CLI's own help text is generated
 * from the same list the dispatcher uses, so a stage cannot be documented
 * without existing or exist without being documented. `implemented: false` is a
 * declared gap, not a silent one.
 */

export interface Stage {
  name: string;
  summary: string;
  implemented: boolean;
  /** Returns the process exit code. */
  run: (argv: string[]) => Promise<number>;
}

const notBuilt = async (): Promise<number> => 70;

export const STAGES: Stage[] = [
  {
    name: "harvest",
    summary: "fetch the subject at a pinned SHA through raw API paths, count-verified (#4)",
    implemented: true,
    run: async (argv) => (await import("./commands/harvest.js")).harvestCommand(argv),
  },
  {
    name: "probe",
    summary: "run the mechanical probe library over the harvest, emitting candidate nodes (#5)",
    implemented: true,
    run: async (argv) => (await import("./commands/probe.js")).probeCommand(argv),
  },
  {
    name: "gate",
    summary: "confirm each candidate against the tree in both directions (#5, #7 point 7)",
    implemented: true,
    run: async (argv) => (await import("./commands/probe.js")).gateCommand(argv),
  },
  {
    name: "rank",
    summary: "score interview_value under the versioned rubric; delete by floor and budget (#9)",
    implemented: true,
    run: async (argv) => (await import("./commands/rank.js")).rankCommand(argv),
  },
  {
    name: "render",
    summary: "atlas.json -> one self-contained HTML artifact (#7)",
    implemented: true,
    run: async (argv) => (await import("./commands/render.js")).renderCommand(argv),
  },
  {
    name: "audit",
    summary: "the twenty-check adversarial pass; stamps its own result into the artifact (#8)",
    implemented: true,
    run: async (argv) => (await import("./commands/audit.js")).auditCommand(argv),
  },
  {
    name: "run",
    summary: "orchestrate every stage over the content-addressed cache",
    implemented: false,
    run: notBuilt,
  },
  {
    name: "validate",
    summary: "validate an atlas.json against the generated JSON Schema, fail closed (#3)",
    implemented: true,
    run: async (argv) => (await import("./commands/validate.js")).validateCommand(argv),
  },
];
