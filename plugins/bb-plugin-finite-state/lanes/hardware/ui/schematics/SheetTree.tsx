import { Icon } from "@bb/shared-ui/icon";

export interface SheetTreeNode {
  sheetPath: string;
  name: string;
  children: SheetTreeNode[];
}

interface FlatSheet {
  sheetPath: string;
  name: string;
  parentSheetPath: string | null;
}

export function buildSheetTree(sheets: FlatSheet[]): SheetTreeNode[] {
  const nodes = new Map<string, SheetTreeNode>();
  for (const sheet of sheets) {
    nodes.set(sheet.sheetPath, {
      sheetPath: sheet.sheetPath,
      name: sheet.name,
      children: [],
    });
  }
  const roots: SheetTreeNode[] = [];
  for (const sheet of sheets) {
    const node = nodes.get(sheet.sheetPath);
    if (!node) continue;
    const parent = sheet.parentSheetPath
      ? nodes.get(sheet.parentSheetPath)
      : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (items: SheetTreeNode[]): void => {
    items.sort((left, right) => left.name.localeCompare(right.name));
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  return roots;
}

function TreeBranch({
  nodes,
  selectedSheetPath,
  onSelect,
  depth,
}: {
  nodes: SheetTreeNode[];
  selectedSheetPath: string;
  onSelect(sheetPath: string): void;
  depth: number;
}): React.JSX.Element {
  return (
    <div role={depth === 0 ? "tree" : "group"}>
      {nodes.map((node) => (
        <div key={node.sheetPath}>
          <button
            aria-current={
              selectedSheetPath === node.sheetPath ? "page" : undefined
            }
            className={`flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-xs transition-colors ${selectedSheetPath === node.sheetPath ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            onClick={() => onSelect(node.sheetPath)}
            role="treeitem"
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            type="button"
          >
            <Icon
              className="size-3.5 shrink-0"
              name={node.children.length > 0 ? "GitBranch" : "File"}
            />
            <span className="truncate">{node.name}</span>
          </button>
          {node.children.length > 0 ? (
            <TreeBranch
              depth={depth + 1}
              nodes={node.children}
              onSelect={onSelect}
              selectedSheetPath={selectedSheetPath}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function SheetTree({
  nodes,
  breadcrumb,
  selectedSheetPath,
  onSelect,
}: {
  nodes: SheetTreeNode[];
  breadcrumb: Array<{ sheetPath: string; name: string }>;
  selectedSheetPath: string;
  onSelect(sheetPath: string): void;
}): React.JSX.Element {
  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border bg-card/70">
      <div className="border-b border-border px-3 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Sheets
        </p>
        <div
          aria-label="Selected sheet path"
          className="mt-2 flex min-w-0 flex-wrap items-center gap-1 text-xs"
        >
          {breadcrumb.map((part, index) => (
            <span
              className="flex min-w-0 items-center gap-1"
              key={part.sheetPath}
            >
              {index > 0 ? (
                <span aria-hidden="true" className="text-muted-foreground">
                  /
                </span>
              ) : null}
              <span
                className={
                  index === breadcrumb.length - 1
                    ? "truncate font-medium text-foreground"
                    : "truncate text-muted-foreground"
                }
              >
                {part.name}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <TreeBranch
          depth={0}
          nodes={nodes}
          onSelect={onSelect}
          selectedSheetPath={selectedSheetPath}
        />
      </div>
    </aside>
  );
}
