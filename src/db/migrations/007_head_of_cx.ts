/** The role shown as "CS Director" is now called Head of CX. The role key (cs_director) is unchanged. */
export const migration007 = /* sql */ `
UPDATE rules_config SET description = replace(description, 'CS Directors', 'Head of CX') WHERE description LIKE '%CS Directors%';
`;
