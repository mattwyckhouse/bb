import { useBbNavigate } from "@bb/plugin-sdk/app";
import { Icon } from "@bb/shared-ui/icon";
import { HARDWARE_TABS, type HardwareTab } from "./route.js";

interface HardwareProjectOption {
  projectKey: string;
  name: string;
}

const tabLabels: Record<HardwareTab, string> = {
  schematics: "Schematics",
  board: "Board",
  fab: "Fabrication",
};

export function HardwareHeader({
  activeTab,
  projects,
  projectKey,
  onProjectChange,
}: {
  activeTab: HardwareTab;
  projects: HardwareProjectOption[];
  projectKey: string;
  onProjectChange(projectKey: string): void;
}): React.JSX.Element {
  const navigate = useBbNavigate();
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
      <div className="flex items-center gap-2">
        <Icon className="text-muted-foreground" name="Layers" />
        <h1 className="text-sm font-semibold">Hardware design</h1>
      </div>
      <nav aria-label="Hardware views" className="flex h-full items-end gap-1">
        {HARDWARE_TABS.map((tab) => (
          <button
            aria-current={activeTab === tab ? "page" : undefined}
            className={`h-9 border-b-2 px-3 text-xs font-medium transition-colors ${activeTab === tab ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            key={tab}
            onClick={() => navigate.toPluginPanel("hardware", { subPath: tab })}
            type="button"
          >
            {tabLabels[tab]}
          </button>
        ))}
      </nav>
      {projects.length > 1 ? (
        <div className="ml-auto flex items-center gap-2">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor="hardware-project"
          >
            Project
          </label>
          <select
            aria-label="Hardware project"
            className="h-8 max-w-64 rounded-md border border-input bg-background px-2 font-mono text-xs"
            id="hardware-project"
            onChange={(event) => onProjectChange(event.target.value)}
            value={projectKey}
          >
            {projects.map((project) => (
              <option key={project.projectKey} value={project.projectKey}>
                {project.name} · {project.projectKey}
              </option>
            ))}
          </select>
        </div>
      ) : projectKey ? (
        <span
          className="ml-auto max-w-64 truncate font-mono text-xs text-muted-foreground"
          title={projectKey}
        >
          {projectKey}
        </span>
      ) : null}
    </header>
  );
}
