function normalizeRule(groupId, groupRule, defaultRule) {
  const merged = {
    ...defaultRule,
    ...groupRule,
  };

  if (!merged.triggerPrefix) {
    throw new Error(`Group ${groupId} is missing required field: triggerPrefix`);
  }

  return {
    groupId,
    triggerPrefix: String(merged.triggerPrefix),
    triggerSuffix: String(merged.triggerSuffix ?? '挂闪电'),
    probability: Number(merged.probability ?? 0),
    muteDurationSeconds: Number(merged.muteDurationSeconds ?? 5),
    triggerReply: String(merged.triggerReply ?? '⚡ 挂上闪电了，下一位发言者要小心。'),
    successReply: String(merged.successReply ?? '⚡ 闪电命中，已禁言 5 秒。'),
    failureReply: String(merged.failureReply ?? '闪电劈歪了！'),
    enabledActions: Array.isArray(merged.enabledActions) ? merged.enabledActions : ['temporaryMute'],
    motherModeEnabled: Boolean(merged.motherModeEnabled ?? false),
    sphereLightningModeEnabled: Boolean(merged.sphereLightningModeEnabled ?? false),
  };
}

export class RuleRegistry {
  constructor(groupRules, defaultRule) {
    this.defaultRule = normalizeRule('__default__', {}, defaultRule);
    this.rules = new Map(
      Object.entries(groupRules).map(([groupId, groupRule]) => [groupId, normalizeRule(groupId, groupRule, defaultRule)]),
    );
  }

  get(groupId) {
    const normalizedGroupId = String(groupId);
    const explicitRule = this.rules.get(normalizedGroupId);
    if (explicitRule) {
      return explicitRule;
    }

    return {
      ...this.defaultRule,
      groupId: normalizedGroupId,
    };
  }

  getAllGroupIds() {
    return Array.from(this.rules.keys());
  }

  getGroupDefaults() {
    return Object.fromEntries(
      Array.from(this.rules.entries(), ([groupId, rule]) => [groupId, {
        motherModeEnabled: rule.motherModeEnabled,
        sphereLightningModeEnabled: rule.sphereLightningModeEnabled,
      }]),
    );
  }
}
