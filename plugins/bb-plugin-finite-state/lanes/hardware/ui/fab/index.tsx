import { Icon } from "@bb/shared-ui/icon";

export function FabTabStub(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
        <Icon className="mx-auto size-6 text-muted-foreground" name="File" />
        <h2 className="mt-3 text-base font-semibold">
          Fabrication checks arrive in WP-77
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Gerbers, drill files, netlists, and DRC/ERC results will compose into
          this tab.
        </p>
      </div>
    </div>
  );
}
