export function createTemporaryMuteAction() {
  return {
    key: 'temporaryMute',
    async execute(context) {
      const {
        apiClient,
        groupId,
        userId,
        durationSeconds,
      } = context;

      await apiClient.call('set_group_ban', {
        group_id: Number(groupId),
        user_id: Number(userId),
        duration: Number(durationSeconds),
      });
    },
  };
}
