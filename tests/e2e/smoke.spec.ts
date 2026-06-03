import { expect, test } from "@playwright/test";

test("loads, selects AAPL, renders indicators and an AI brief", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Fundamental Analysis Dashboard/i }),
  ).toBeVisible();

  // Open the asset selector and choose AAPL.
  await page.getByRole("combobox", { name: /select an asset/i }).click();
  await page.getByPlaceholder(/type a symbol or name/i).fill("AAPL");
  await page.getByRole("option", { name: /AAPL/i }).click();

  // The indicator grid should render at least 15 cards.
  const grid = page.getByTestId("indicator-grid");
  await expect(grid).toBeVisible();
  await expect
    .poll(async () => page.getByTestId("indicator-card").count(), {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(15);

  // The AI brief panel should populate with non-empty text.
  const summary = page.getByTestId("ai-brief-summary");
  await expect(summary).toBeVisible({ timeout: 15_000 });
  await expect(summary).not.toBeEmpty();

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
