/**
 * One definition of "the subject declares this type a Spring component", shared
 * by the Flow producer and the Flow gate.
 *
 * The producer reads annotation nodes off a parse tree (`symbols.ts`); the gate
 * matches annotation text in the pinned blob (`src/gate/flow.ts`). Those two
 * derivations are deliberately INDEPENDENT - that is what makes the gate a check
 * rather than an echo. But they must agree on WHICH annotations name a bean, or
 * a set the producer considers container-managed is one the gate reports as
 * unmanaged and contradicts - a real closed-set arrow quarantined purely because
 * the two sides kept different lists. So the list - the definition - lives here
 * and both sides import it, exactly as `route.ts` shares one definition of "the
 * same route" and `manifests.ts` shares one definition of "declared". The
 * RESOLUTION (how each side reads it) stays split.
 *
 * `@Bean` factory methods are deliberately absent for the reason `symbols.ts`
 * records: the bean they produce is typed through a factory this reader cannot
 * follow, and a set that is partly declared and partly guessed is worse than one
 * that says what it read.
 */
export const SPRING_STEREOTYPES = [
  "Component",
  "Service",
  "Repository",
  "Controller",
  "RestController",
  "ControllerAdvice",
  "RestControllerAdvice",
  "Configuration",
];

/**
 * Whether the subject runs Spring at all.
 *
 * The framework-level half of `Probe.applies`, shared by every Spring Flow
 * adapter for the reason the list above is shared: three adapters keeping three
 * copies of "does this subject import org.springframework" would eventually
 * answer differently, and "no Spring here" would then mean one thing to the route
 * adapter and another to the scheduled one. The toolchain test above it answers
 * "does this subject have Java"; this answers the framework question, and each
 * adapter still answers its own entry-family question by itself (#5, #6).
 */
export const declaresSpring = (paths: string[], read: (path: string) => string | null): boolean =>
  paths.some((path) => /^\s*import\s+org\.springframework\./m.test(read(path) ?? ""));
