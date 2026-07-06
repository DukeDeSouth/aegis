/**
 * Конфигурация расписаний (Sprint 9).
 */
export interface ScheduleEntry {
  id: string;
  cron: string;
  text: string;
  session_id?: string;
}
