/** Small, privacy-neutral starter tasks for the popup.
 *
 * Presets only fill the local task text box. They never inspect the page,
 * persist values, or change the reasoning protocol. A user can edit the
 * generated task before starting the agent.
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
    label: 'Fill public fields from my instructions',
    task: 'Fill the requested public fields using only the values I provided in this task, then stop before submitting.',
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
