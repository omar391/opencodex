import { describe, expect, test } from "bun:test";
import { buildProviderWorkspace, isFreeProvider, providerTier, type WorkspaceItem } from "../../gui/src/provider-workspace/catalog";
import { bucketPresets, presetTier, type CatalogPreset } from "../../gui/src/components/provider-catalog/provider-presets";
import { isAcpProvider } from "../../gui/src/provider-workspace/acp-agent";
import { authModeLabel } from "../../gui/src/components/provider-workspace/ProviderRail";
import { providerAuthSurface } from "../../gui/src/provider-workspace/auth";
import { en } from "../../gui/src/i18n/en";
import { DICTS } from "../../gui/src/i18n/catalogs";
import { interpolate, type TFn } from "../../gui/src/i18n/shared";

/**
 * ACP-agent rows (`devin-acp`, `antigravity-acp`) are keyless because the installed
 * agent CLI owns auth and billing — not because they are free. The dashboard reads
 * `keyOptional` as free pricing, which filed them under Free with a Free badge.
 * These pin them to the dedicated ACP catalog tab and paid workspace tier, and pin
 * the badge/tab copy in every locale.
 */

// The row as /api/provider-presets derives it from src/providers/registry/entries-extended.ts.
const DEVIN_ACP: CatalogPreset = {
  id: "devin-acp",
  label: "Devin ACP",
  adapter: "acp",
  baseUrl: "https://cli.devin.ai",
  auth: "key",
  keyOptional: true,
};

const englishT: TFn = (key, vars) => interpolate(en[key], vars);

describe("ACP agent grouping", () => {
  test("the adapter, not the provider id, identifies an ACP row", () => {
    expect(isAcpProvider({ adapter: "acp" })).toBe(true);
    expect(isAcpProvider({ adapter: " acp " })).toBe(true);
    expect(isAcpProvider({ adapter: "claude-cli" })).toBe(false);
    expect(isAcpProvider({ adapter: "openai-chat" })).toBe(false);
    expect(isAcpProvider({})).toBe(false);
  });

  test("an ACP row is paid-tier while an ordinary keyless row stays free", () => {
    const row = { adapter: "acp", baseUrl: DEVIN_ACP.baseUrl, authMode: "key", keyOptional: true };
    expect(isFreeProvider(row)).toBe(false);
    expect(providerTier("devin-acp", row)).toBe("paid");
    expect(isFreeProvider({ adapter: "openai-chat", baseUrl: "https://api.example.com/v1", keyOptional: true })).toBe(true);
  });

  test("the add-provider catalog lists ACP rows under ACP and nowhere else", () => {
    const keylessFree: CatalogPreset = { id: "keyless", label: "Keyless", adapter: "openai-chat", baseUrl: "https://api.example.com/v1", auth: "key", keyOptional: true };
    const buckets = bucketPresets([DEVIN_ACP, keylessFree]);
    expect(buckets.acp.map(p => p.id)).toEqual(["devin-acp"]);
    expect(buckets.free.map(p => p.id)).toEqual(["keyless"]);
    expect(buckets.paid).toEqual([]);
    expect(buckets.accounts).toEqual([]);
    expect(buckets.local).toEqual([]);
  });

  test("the configured row stays ready, is tagged paid, labelled ACP and offers no key prompt", () => {
    const sections = buildProviderWorkspace({
      "devin-acp": { adapter: "acp", baseUrl: DEVIN_ACP.baseUrl, authMode: "key", keyOptional: true },
    });
    const item = sections.ready.find(p => p.name === "devin-acp") as WorkspaceItem;
    expect(item.tier).toBe("paid");
    expect(authModeLabel(item, englishT)).toBe(en["modal.badge.acp"]);
    expect(providerAuthSurface(item)).toBeNull();
  });

  // `keyOptional` reaches the row from the registry; a hand-authored ACP row without it
  // must still be keyless because the agent CLI owns auth — same edge as claude-cli.
  test("a custom ACP row without keyOptional stays ready and keyless", () => {
    const sections = buildProviderWorkspace({
      agent: { adapter: "acp", baseUrl: DEVIN_ACP.baseUrl, authMode: "key" },
    });
    expect(sections.needsSetup).toEqual([]);
    const item = sections.ready.find(p => p.name === "agent") as WorkspaceItem;
    expect(item).toBeDefined();
    expect(item.tier).toBe("paid");
    expect(isFreeProvider(item)).toBe(false);
    expect(authModeLabel(item, englishT)).toBe(en["modal.badge.acp"]);
    expect(providerAuthSurface(item)).toBeNull();
  });
});

describe("ACP agent copy", () => {
  const keys = ["modal.tab.acp", "modal.badge.acp"] as const;

  test("every locale translates the tab and badge", () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const key of keys) {
        expect(dict[key]?.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
        if (locale !== "en") expect(dict[key], `${locale} ${key}`).not.toBe(en[key]);
      }
    }
  });
});
