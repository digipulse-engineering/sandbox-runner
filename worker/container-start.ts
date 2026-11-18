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
          target.start(options);
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
