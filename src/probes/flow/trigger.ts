/**
 * One definition of "the container starts this method for you", shared by the
 * two container-triggered Flow adapters and by the Flow gate (#35, PR 8).
 *
 * A Spring HTTP handler is reached because something outside made a request. A
 * `@Scheduled` method and a `@KafkaListener` method are reached because the
 * container decided to, on a clock or on a message, and the only thing the tree
 * establishes about that trigger is the annotation itself - its name, and the
 * expression it declares. So that is exactly what is shared here: the vocabulary
 * and how an expression is read out of an annotation's argument text.
 *
 * The producer reads annotation nodes off a parse tree (`symbols.ts`); the gate
 * matches annotation text in the pinned blob. Those two derivations stay
 * independent - that is what makes the gate a check rather than an echo - but
 * they must agree on WHICH annotations name a trigger and on WHAT the expression
 * is, or a real entry is quarantined purely because the two sides kept different
 * lists. Same rule as `stereotype.ts`, `route.ts` and `manifests.ts`: one
 * definition here, resolution split.
 */

/** The annotation Spring reads a clock trigger from. */
export const SCHEDULED_ANNOTATION = "Scheduled";

/**
 * The annotation that turns `@Scheduled` on.
 *
 * It is required, and requiring it is not pedantry: Spring Boot autoconfigures
 * the listener containers below when their starter is on the classpath, but it
 * does NOT enable scheduling. A `@Scheduled` method in a subject that never
 * writes `@EnableScheduling` is a method nothing calls, and drawing a Flow from
 * it would be the engine asserting an execution the subject's own wiring does
 * not start.
 */
export const ENABLE_SCHEDULING_ANNOTATION = "EnableScheduling";

/**
 * The message/event listener annotations this phase can genuinely establish.
 *
 * Each of the four is a declaration in the tree that names the destination it
 * subscribes to, which is the whole of what is claimed. What is NOT claimed is
 * who publishes to it: a Kafka topic's producer may not be in this subject at
 * all, and even the in-process `@EventListener` case needs a publisher stitch
 * that is its own piece of work (see the PR body's follow-ups). This is the same
 * split PR 4 made for the Spring route, which was claimed at caption level until
 * PR 6 had a real caller to draw an arrow from.
 */
export const MESSAGE_ANNOTATIONS = [
  "EventListener",
  "KafkaListener",
  "JmsListener",
  "RabbitListener",
] as const;

export type MessageAnnotation = (typeof MESSAGE_ANNOTATIONS)[number];

/** The attributes a `@Scheduled` trigger may be written as, in declaration order. */
export const TRIGGER_ATTRIBUTES = [
  "cron",
  "fixedDelay",
  "fixedDelayString",
  "fixedRate",
  "fixedRateString",
] as const;

/** The attributes each listener annotation names its destination with. */
export const DESTINATION_ATTRIBUTES: Record<MessageAnnotation, readonly string[]> = {
  EventListener: ["classes", "value"],
  KafkaListener: ["topics", "topicPattern"],
  JmsListener: ["destination"],
  RabbitListener: ["queues"],
};

export interface DeclaredExpression {
  /** The attribute the subject wrote it under. */
  attribute: string;
  /** The value exactly as declared, quotes stripped, whitespace collapsed. */
  text: string;
}

/**
 * One named attribute's value, read out of an annotation's raw argument text.
 *
 * Both quoted and unquoted forms are read, because both are how these
 * annotations are written: `cron = "0 0 * * * *"` and `fixedDelay = 60000` are
 * the same kind of claim. A `{...}` array takes its first element, which is what
 * a single-destination listener writes when it writes an array of one; a listener
 * on several destinations therefore reports the first, and the entry title says
 * so by carrying the declared text verbatim rather than a summary.
 */
const attributeValue = (args: string, name: string): string | null => {
  const named = new RegExp(`(?:^|[(,\\s])${name}\\s*=\\s*(\\{[^}]*\\}|"[^"]*"|[^,)\\s]+)`).exec(args);
  const raw = named?.[1];
  if (raw === undefined) return null;
  const inner = raw.startsWith("{") ? (/"([^"]*)"|([^,{}\s]+)/.exec(raw.slice(1, -1))?.[0] ?? "") : raw;
  const text = inner.replace(/^"|"$/g, "").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
};

/**
 * The clock expression a `@Scheduled` annotation declares, or null.
 *
 * Null is a real outcome and the adapter cuts on it by name: `@Scheduled()` with
 * no attribute at all is not a schedule this reader can state, and a Flow whose
 * entry box printed an empty trigger would be asserting one.
 *
 * A property placeholder (`cron = "${app.cue.cron}"`) is returned as declared.
 * That is honest: the declaration IS the placeholder, the figure prints exactly
 * what the file says, and nothing here claims to know what the deployment
 * resolves it to.
 */
export const declaredTrigger = (args: string): DeclaredExpression | null => {
  for (const attribute of TRIGGER_ATTRIBUTES) {
    const text = attributeValue(args, attribute);
    if (text !== null) return { attribute, text };
  }
  return null;
};

/**
 * The destination a listener annotation declares.
 *
 * `@EventListener` is the one that usually declares nothing: the event it
 * listens for is its parameter type, so the caller passes that in and this
 * returns it under the `parameter` attribute. A listener that declares neither -
 * `@EventListener` on a no-argument method - yields null, and the adapter cuts by
 * name rather than drawing an entry whose subscription it cannot state.
 */
export const declaredDestination = (
  annotation: MessageAnnotation,
  args: string,
  parameterType: string | null,
): DeclaredExpression | null => {
  for (const attribute of DESTINATION_ATTRIBUTES[annotation]) {
    const text = attributeValue(args, attribute);
    if (text !== null) return { attribute, text: text.replace(/\.class$/, "") };
  }
  const bare = /^\(\s*"([^"]*)"/.exec(args.trim())?.[1];
  if (bare !== undefined && bare !== "") return { attribute: "value", text: bare };
  return annotation === "EventListener" && parameterType !== null
    ? { attribute: "parameter", text: parameterType }
    : null;
};

/**
 * The argument text of one annotation, read out of a source span by TEXT.
 *
 * This is the gate's half. The producer takes annotation nodes off a parse tree;
 * this scans the cited span for `@Name` and balances the parentheses after it, so
 * the two sides reach the same argument string by different routes and a
 * disagreement quarantines the Flow rather than being averaged away.
 *
 * It returns `""` for a marker annotation with no parentheses, exactly as the
 * parse-tree side does, and null when the annotation is not in the span at all.
 */
export const annotationArgsInText = (span: string, name: string): string | null => {
  const at = new RegExp(`@${name}\\b`).exec(span);
  if (!at) return null;
  let i = at.index + at[0].length;
  while (i < span.length && /\s/.test(span[i]!)) i += 1;
  if (span[i] !== "(") return "";
  let depth = 0;
  for (let j = i; j < span.length; j += 1) {
    if (span[j] === "(") depth += 1;
    else if (span[j] === ")") {
      depth -= 1;
      if (depth === 0) return span.slice(i, j + 1);
    }
  }
  return null;
};
