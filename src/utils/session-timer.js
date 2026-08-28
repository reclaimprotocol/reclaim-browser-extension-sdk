/**
 * Session timer utility functions for Reclaim Browser Extension
 * Handles session timeout management
 */

import { SESSION_TIMER_DURATION_MS } from "./constants/config";
// Safe to import directly: background.js is the only importer of this module, so
// this cannot start the hub in a consumer page. These lines used to be bare
// console.log — the one part of the flow visible locally and unqueryable
// remotely, ignoring both consoleEnabled and logLevel.
import { loggingHub } from "./logger/LoggingHub";
import { EVENT_TYPES } from "./logger/constants";

export class SessionTimerManager {
  constructor() {
    this.sessionTimer = null;
    this.sessionTimerDuration = SESSION_TIMER_DURATION_MS;
    this.sessionTimerPaused = false;
    this.sessionTimerRemainingTime = 0;
    this.sessionTimerStartTime = 0;

    this.onSessionTimeout = null;
  }

  /**
   * Set callback for session timer event
   * @param {Function} sessionTimeoutCallback - Called when session timer expires
   */
  setCallbacks(sessionTimeoutCallback) {
    this.onSessionTimeout = sessionTimeoutCallback;
  }

  /**
   * Start session timer (default 30 seconds)
   */
  startSessionTimer() {
    loggingHub.debug("[SESSION TIMER] Starting session timer", "background.session");
    this.clearSessionTimer();

    this.sessionTimerStartTime = Date.now();
    this.sessionTimer = setTimeout(() => {
      if (this.sessionTimer !== null) {
        loggingHub.error("[SESSION TIMER] Session timer expired", "background.session", {
          eventType: EVENT_TYPES.CLAIM_CREATION_TIMED_OUT_EXCEPTION,
        });
        if (this.onSessionTimeout) {
          this.onSessionTimeout("Session timeout: No proofs generated within time limit");
        }
      } else {
        loggingHub.debug(
          "[SESSION TIMER] Timer was already cleared, ignoring timeout",
          "background.session",
        );
      }
    }, this.sessionTimerDuration);
  }

  /**
   * Reset session timer (called after successful proof generation)
   */
  resetSessionTimer() {
    loggingHub.debug("[SESSION TIMER] Resetting session timer", "background.session");
    this.clearSessionTimer();
    this.startSessionTimer();
  }

  /**
   * Clear session timer
   */
  clearSessionTimer() {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  /**
   * Pause session timer while processing a proof
   */
  pauseSessionTimer() {
    if (this.sessionTimer && !this.sessionTimerPaused) {
      loggingHub.debug("[SESSION TIMER] Pausing session timer", "background.session");
      // Calculate remaining time
      const elapsedTime = Date.now() - this.sessionTimerStartTime;
      this.sessionTimerRemainingTime = Math.max(0, this.sessionTimerDuration - elapsedTime);

      this.clearSessionTimer();
      this.sessionTimerPaused = true;
    }
  }

  /**
   * Resume session timer after processing a proof
   */
  resumeSessionTimer() {
    if (this.sessionTimerPaused) {
      loggingHub.debug(
        `[SESSION TIMER] Resuming session timer with ${this.sessionTimerRemainingTime}ms remaining`,
        "background.session",
      );

      this.sessionTimer = setTimeout(() => {
        loggingHub.error("[SESSION TIMER] Session timer expired", "background.session", {
          eventType: EVENT_TYPES.CLAIM_CREATION_TIMED_OUT_EXCEPTION,
        });
        if (this.onSessionTimeout) {
          this.onSessionTimeout("Session timeout: No proofs generated within time limit");
        }
      }, this.sessionTimerRemainingTime);

      this.sessionTimerStartTime =
        Date.now() - (this.sessionTimerDuration - this.sessionTimerRemainingTime);
      this.sessionTimerPaused = false;
    }
  }

  /**
   * Clear all timers
   */
  clearAllTimers() {
    loggingHub.debug("[SESSION TIMER] Clearing all timers", "background.session");
    this.clearSessionTimer();
    this.sessionTimerPaused = false;
    this.sessionTimerRemainingTime = 0;
    this.sessionTimerStartTime = 0;
  }

  /**
   * Set custom duration for session timer
   * @param {number} sessionDuration - Session timer duration in milliseconds
   */
  setTimerDuration(sessionDuration) {
    if (sessionDuration && typeof sessionDuration === "number") {
      this.sessionTimerDuration = sessionDuration;
    }
  }
}
