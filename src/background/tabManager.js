// Tab management for background script
// Handles tab creation and managedTabs logic

export function createProviderTab(ctx, providerUrl, providerId) {
  // Implementation will be filled in after moving logic from background.js
}

export function isManagedTab(ctx, tabId) {
  return ctx.managedTabs.has(tabId);
}

export function removeManagedTab(ctx, tabId) {
  ctx.managedTabs.delete(tabId);
}
