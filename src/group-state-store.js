const FALLBACK_GROUP_DEFAULTS = Object.freeze({
  motherModeEnabled: false,
  sphereLightningModeEnabled: false,
});

function normalizeGroupDefaults(groupDefaults) {
  if (groupDefaults === null || typeof groupDefaults !== 'object' || Array.isArray(groupDefaults)) {
    throw new TypeError('groupDefaults must be an object');
  }

  const normalized = {};
  for (const [groupId, defaults] of Object.entries(groupDefaults)) {
    if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
      throw new TypeError(`Group ${groupId} defaults must be an object`);
    }

    if (typeof defaults.motherModeEnabled !== 'boolean') {
      throw new TypeError(`Group ${groupId} motherModeEnabled must be boolean`);
    }

    if (typeof defaults.sphereLightningModeEnabled !== 'boolean') {
      throw new TypeError(`Group ${groupId} sphereLightningModeEnabled must be boolean`);
    }

    normalized[String(groupId)] = {
      motherModeEnabled: defaults.motherModeEnabled,
      sphereLightningModeEnabled: defaults.sphereLightningModeEnabled,
    };
  }

  return normalized;
}

export class GroupStateStore {
  constructor({ groupDefaults = {} } = {}) {
    this.groupStates = new Map();
    this.groupDefaults = normalizeGroupDefaults(groupDefaults);
  }

  getGroupDefaultsSnapshot() {
    return structuredClone(this.groupDefaults);
  }

  replaceGroupDefaults(groupDefaults) {
    const normalized = normalizeGroupDefaults(groupDefaults);
    this.groupDefaults = normalized;
  }

  get(groupId) {
    const normalizedGroupId = String(groupId);
    if (!this.groupStates.has(normalizedGroupId)) {
      this.groupStates.set(normalizedGroupId, this.createInitialState(this.groupDefaults[normalizedGroupId]));
    }

    return this.groupStates.get(normalizedGroupId);
  }

  arm(groupId, actionKey, armedByUserId, increment = 1) {
    const currentState = this.get(groupId);
    const nextState = {
      ...currentState,
      armed: true,
      armedCount: Math.min(currentState.armedCount + increment, 100),
      activeActionKey: actionKey,
      armedByUserId,
      armedAt: new Date().toISOString(),
    };

    this.groupStates.set(String(groupId), nextState);
    return nextState;
  }

  reset(groupId) {
    const currentState = this.get(groupId);
    const nextState = {
      ...currentState,
      armed: false,
      armedCount: 0,
      activeActionKey: null,
      armedByUserId: null,
      armedAt: null,
    };
    this.groupStates.set(String(groupId), nextState);
    return nextState;
  }

  ignoreUser(groupId, userId) {
    const currentState = this.get(groupId);
    const normalizedUserId = String(userId);
    const nextState = {
      ...currentState,
      ignoredUserIds: {
        ...(currentState.ignoredUserIds ?? {}),
        [normalizedUserId]: true,
      },
    };

    this.groupStates.set(String(groupId), nextState);
    return nextState;
  }

  unignoreUser(groupId, userId) {
    const currentState = this.get(groupId);
    const normalizedUserId = String(userId);
    const nextIgnoredUserIds = { ...(currentState.ignoredUserIds ?? {}) };
    delete nextIgnoredUserIds[normalizedUserId];

    const nextState = {
      ...currentState,
      ignoredUserIds: nextIgnoredUserIds,
    };

    this.groupStates.set(String(groupId), nextState);
    return nextState;
  }

  isUserIgnored(groupId, userId) {
    const currentState = this.get(groupId);
    const normalizedUserId = String(userId);
    return currentState.ignoredUserIds?.[normalizedUserId] === true;
  }

  recordMessage(groupId, repeatKey) {
    const currentState = this.get(groupId);
    const nextMessageIndex = currentState.messageIndex + 1;
    const consecutiveCount = currentState.lastRepeatKey === repeatKey ? currentState.lastMessageRepeatCount + 1 : 1;
    const nextRecentRepeatTriggers = currentState.lastRepeatKey === repeatKey
      ? (currentState.recentRepeatTriggers ?? {})
      : {};

    const nextState = {
      ...currentState,
      messageIndex: nextMessageIndex,
      lastRepeatKey: repeatKey,
      lastMessageRepeatCount: consecutiveCount,
      recentRepeatTriggers: nextRecentRepeatTriggers,
    };

    this.groupStates.set(String(groupId), nextState);
    return nextState;
  }

  setMotherModeEnabled(groupId, enabled) {
    const currentState = this.get(groupId);
    const nextState = {
      ...currentState,
      motherModeEnabled: enabled,
    };

    this.groupStates.set(String(groupId), nextState);
    return nextState;
  }

  setSphereLightningModeEnabled(groupId, enabled) {
    const currentState = this.get(groupId);
    const nextState = {
      ...currentState,
      sphereLightningModeEnabled: enabled,
    };

    this.groupStates.set(String(groupId), nextState);
    return nextState;
  }

  markRepeatTriggered(groupId, repeatKey) {
    const currentState = this.get(groupId);
    const nextState = {
      ...currentState,
      recentRepeatTriggers: {
        ...(currentState.recentRepeatTriggers ?? {}),
        [repeatKey]: true,
      },
    };

    this.groupStates.set(String(groupId), nextState);
    return nextState;
  }

  clearRepeatState(groupId) {
    const currentState = this.get(groupId);
    const nextState = {
      ...currentState,
      lastRepeatKey: null,
      lastMessageRepeatCount: 0,
      recentRepeatTriggers: {},
    };

    this.groupStates.set(String(groupId), nextState);
    return nextState;
  }

  consumeLightning(groupId) {
    const currentState = this.get(groupId);
    const nextCount = Math.max(0, currentState.armedCount - 1);
    const nextState = {
      ...currentState,
      armed: nextCount > 0,
      armedCount: nextCount,
      activeActionKey: nextCount > 0 ? currentState.activeActionKey : null,
      armedByUserId: nextCount > 0 ? currentState.armedByUserId : null,
      armedAt: nextCount > 0 ? currentState.armedAt : null,
    };

    this.groupStates.set(String(groupId), nextState);
    return nextState;
  }

  createInitialState(groupDefaults = FALLBACK_GROUP_DEFAULTS) {
    return {
      armed: false,
      armedCount: 0,
      activeActionKey: null,
      armedByUserId: null,
      armedAt: null,
      messageIndex: 0,
      lastRepeatKey: null,
      lastMessageRepeatCount: 0,
      recentRepeatTriggers: {},
      motherModeEnabled: groupDefaults.motherModeEnabled,
      sphereLightningModeEnabled: groupDefaults.sphereLightningModeEnabled,
      yesNoReplyEnabled: true,
      ignoredUserIds: {},
    };
  }

  setYesNoReplyEnabled(groupId, enabled) {
    const currentState = this.get(groupId);
    const nextState = {
      ...currentState,
      yesNoReplyEnabled: Boolean(enabled),
    };

    this.groupStates.set(String(groupId), nextState);
    return nextState;
  }

  isYesNoReplyEnabled(groupId) {
    const currentState = this.get(groupId);
    return currentState.yesNoReplyEnabled !== false;
  }
}
