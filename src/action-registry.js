import { createTemporaryMuteAction } from './actions/temporary-mute.js';

export class ActionRegistry {
  constructor() {
    this.actions = new Map();
    this.register(createTemporaryMuteAction());
  }

  register(action) {
    this.actions.set(action.key, action);
  }

  get(actionKey) {
    return this.actions.get(actionKey) ?? null;
  }
}
