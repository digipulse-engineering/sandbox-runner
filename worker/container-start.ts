export function guardedContainerStart(
  container: Container, canStart: () => boolean, installEgress?: () => Promise<void>,
): Container {
  // Use the native container as the receiver for its getters and methods.
  // The Harness can still have an asynchronous start in progress during teardown.
  return new Proxy(container, {
    get(target, property) {
      if (property === "start") {
        return (options?: ContainerStartupOptions) => {
          if (!canStart()) throw new Error("Container teardown has begun");
          // Never restore a saved filesystem: each run starts from the clean image.
          const { containerSnapshot: _restored, ...fresh } = (options ?? {}) as ContainerStartupOptions & { containerSnapshot?: unknown };
          target.start(options === undefined ? undefined : fresh);
        };
      }
      if (property === "snapshotContainer") {
        // The pinned Harness snapshots the workspace before an idle stop. A run's workspace
        // holds the checkout and the agent's output, so it must not outlive the container.
        // The Harness treats a failed snapshot as "no workspace" and still destroys the container.
        return async () => {
          throw new Error("Workspace snapshots are disabled");
        };
      }
      if (property === "setInactivityTimeout") {
        // The pinned Harness awaits this immediately after each native start
        // and when adopting a running container, before connecting to its daemon.
        return async (timeout: number) => {
          if (!canStart()) throw new Error("Container teardown has begun");
          await target.setInactivityTimeout(timeout);
          if (!canStart()) throw new Error("Container teardown has begun");
          await installEgress?.();
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
