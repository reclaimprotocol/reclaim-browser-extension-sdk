/**
 * Session timer utility functions for Reclaim Browser Extension
 * Handles session timeout management
 */

import { debugLogger, DebugLogType } from './logger';

export class SessionTimerManager {
    constructor() {
        // Timer for session
        this.sessionTimer = null;
        this.sessionTimerDuration = 30000; // 30 seconds in milliseconds
        this.sessionTimerPaused = false;
        this.sessionTimerRemainingTime = 0;
        this.sessionTimerStartTime = 0;
        
        // Callback for session timeout
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
        debugLogger.info(DebugLogType.SESSION_TIMER, '[SESSION TIMER] Starting session timer');
        // Clear any existing timer
        this.clearSessionTimer();

        this.sessionTimerStartTime = Date.now();
        this.sessionTimer = setTimeout(() => {
            // Check if timer is still valid before firing timeout
            if (this.sessionTimer !== null) {
                debugLogger.error(DebugLogType.SESSION_TIMER, '[SESSION TIMER] Session timer expired');
                if (this.onSessionTimeout) {
                    this.onSessionTimeout("Session timeout: No proofs generated within time limit");
                }
            } else {
                debugLogger.info(DebugLogType.SESSION_TIMER, '[SESSION TIMER] Timer was already cleared, ignoring timeout');
            }
        }, this.sessionTimerDuration);
    }

    /**
     * Reset session timer (called after successful proof generation)
     */
    resetSessionTimer() {
        debugLogger.info(DebugLogType.SESSION_TIMER, '[SESSION TIMER] Resetting session timer');
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
            debugLogger.info(DebugLogType.SESSION_TIMER, '[SESSION TIMER] Pausing session timer');
            // Calculate remaining time
            const elapsedTime = Date.now() - this.sessionTimerStartTime;
            this.sessionTimerRemainingTime = Math.max(0, this.sessionTimerDuration - elapsedTime);

            // Clear the current timer
            this.clearSessionTimer();
            this.sessionTimerPaused = true;
        }
    }

    /**
     * Resume session timer after processing a proof
     */
    resumeSessionTimer() {
        if (this.sessionTimerPaused) {
            debugLogger.info(DebugLogType.SESSION_TIMER, '[SESSION TIMER] Resuming session timer with remaining time:', this.sessionTimerRemainingTime);

            this.sessionTimer = setTimeout(() => {
                debugLogger.error(DebugLogType.SESSION_TIMER, '[SESSION TIMER] Session timer expired');
                if (this.onSessionTimeout) {
                    this.onSessionTimeout("Session timeout: No proofs generated within time limit");
                }
            }, this.sessionTimerRemainingTime);

            this.sessionTimerStartTime = Date.now() - (this.sessionTimerDuration - this.sessionTimerRemainingTime);
            this.sessionTimerPaused = false;
        }
    }

    /**
     * Clear all timers
     */
    clearAllTimers() {
        debugLogger.info(DebugLogType.SESSION_TIMER, '[SESSION TIMER] Clearing all timers');
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
        if (sessionDuration && typeof sessionDuration === 'number') {
            this.sessionTimerDuration = sessionDuration;
        }
    }
} 