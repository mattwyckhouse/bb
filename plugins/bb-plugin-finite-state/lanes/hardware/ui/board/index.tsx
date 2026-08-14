import { Icon } from "@bb/shared-ui/icon";
import { useHardwareSelection } from "../selection.js";

export function BoardTabStub(): React.JSX.Element {
  const [selection] = useHardwareSelection();
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
        <Icon className="mx-auto size-6 text-muted-foreground" name="Layers" />
        <h2 className="mt-3 text-base font-semibold">
          Board view arrives in WP-76
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The shared hardware selection remains active while this renderer is
          staged.
        </p>
        {selection.projectKey ? (
          <output className="mt-3 block font-mono text-xs text-muted-foreground">
            {selection.kind === "part"
              ? selection.reference
              : selection.kind === "net"
                ? selection.netName
                : selection.projectKey}
          </output>
        ) : null}
      </div>
    </div>
  );
}
