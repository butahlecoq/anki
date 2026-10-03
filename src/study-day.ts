/** Anki's default local rollover; users with a custom Anki rollover can be supported later. */
export const DEFAULT_STUDY_DAY_ROLLOVER_HOUR = 4

export function studyDayStart(value: Date, rolloverHour = DEFAULT_STUDY_DAY_ROLLOVER_HOUR) {
  const start = new Date(value.getFullYear(), value.getMonth(), value.getDate(), rolloverHour)
  if (value < start) start.setDate(start.getDate() - 1)
  return start
}

export function studyDayWindow(value: Date, rolloverHour = DEFAULT_STUDY_DAY_ROLLOVER_HOUR) {
  const start = studyDayStart(value, rolloverHour)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, rolloverHour)
  return { start, end }
}

export function studyDayKey(value: Date, rolloverHour = DEFAULT_STUDY_DAY_ROLLOVER_HOUR) {
  const start = studyDayStart(value, rolloverHour)
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
}
