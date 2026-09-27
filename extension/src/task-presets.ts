/** Small starter tasks for the popup and persistent side panel.
 *
 * Presets only fill the local task text box. They never inspect the page,
 * persist values, or change the reasoning protocol. Demo data must remain
 * synthetic and editable because it is processed under the selected grade
 * only after the user explicitly starts a run.
 */
export type TaskPresetId = 'review-submit' | 'fill-public-fields' | 'find-information' | 'scroll-summary';

export type TaskPreset = Readonly<{
  id: TaskPresetId;
  label: string;
  task: string;
}>;

export const TASK_PRESETS: readonly TaskPreset[] = [
  {
    id: 'review-submit',
    label: 'Review and submit a form',
    task: 'Review the visible form, check any required consent checkbox, then submit it.',
  },
  {
    id: 'fill-public-fields',
    label: 'Fill a staff transfer request',
    task: 'Fill the transfer request with: applicant name Aarav Sharma; official email aarav.sharma@example.test; mobile number +91 98765 43210; requested centre Orbital Satellite Centre, Bengaluru; transfer type Family relocation; effective date 2026-11-15. Then check the consent box and ask me to review all fields before submitting the transfer request.',
  },
  {
    id: 'find-information',
    label: 'Find information on this page',
    task: 'Find the requested information on this page and finish when it is visible.',
  },
  {
    id: 'scroll-summary',
    label: 'Read through the page',
    task: 'Scroll through the page and stop when you have reached the relevant section.',
  },
];

export function taskPreset(id: string): TaskPreset | undefined {
  return TASK_PRESETS.find((preset) => preset.id === id);
}
