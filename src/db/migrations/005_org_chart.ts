/** Reporting lines: who each person reports to. CSM to team lead links also come from csm_team. */
export const migration005 = /* sql */ `
ALTER TABLE app_user ADD COLUMN manager_email text;
`;
