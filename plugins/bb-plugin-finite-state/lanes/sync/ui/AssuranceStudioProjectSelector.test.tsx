// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssuranceStudioProjectSelector } from "./AssuranceStudioProjectSelector.js";

afterEach(cleanup);

const candidates = [
  {
    assuranceStudioProjectId: "as-project-one",
    assuranceStudioProjectName: "Gateway Alpha",
    platformProjectVersionName: "2.4",
    syncStatus: "synced",
    isPrimary: true,
  },
  {
    assuranceStudioProjectId: "as-project-two",
    assuranceStudioProjectName: "Gateway Beta",
    platformProjectVersionName: "2.4",
    syncStatus: "synced",
    isPrimary: true,
  },
];

describe("AssuranceStudioProjectSelector", () => {
  it("does not infer a winner from equally primary linked projects", () => {
    const slot = render(
      <AssuranceStudioProjectSelector
        candidates={candidates}
        error={null}
        loading={false}
        onRetry={vi.fn()}
        onSelect={vi.fn()}
        saving={false}
        selectedId={null}
      />,
    );

    expect(
      (slot.getByLabelText("Assurance Studio project") as HTMLSelectElement)
        .value,
    ).toBe("");
    expect(
      slot.getByText("2 linked projects require an explicit choice."),
    ).toBeTruthy();
    expect(
      slot
        .getByRole("button", { name: "Save selection" })
        .getAttribute("disabled"),
    ).not.toBeNull();
  });

  it("submits only the project the operator selected", async () => {
    const onSelect = vi.fn(async () => undefined);
    const slot = render(
      <AssuranceStudioProjectSelector
        candidates={candidates}
        error={null}
        loading={false}
        onRetry={vi.fn()}
        onSelect={onSelect}
        saving={false}
        selectedId={null}
      />,
    );
    fireEvent.change(slot.getByLabelText("Assurance Studio project"), {
      target: { value: "as-project-two" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save selection" }));
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith("as-project-two"),
    );
  });
});
