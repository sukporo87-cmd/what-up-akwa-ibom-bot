// ============================================
// FILE: src/services/tournament.service.js
// NEW: Tournament and sponsored games management
// ============================================

const pool = require('../config/database');
const { logger } = require('../utils/logger');

class TournamentService {
  /**
   * Get all active tournaments
   */
  async getActiveTournaments() {
    try {
      const result = await pool.query(
        `SELECT 
          t.*,
          COUNT(tp.id) as participant_count
         FROM tournaments t
         LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
         WHERE t.status = 'active'
         AND t.start_date <= NOW()
         AND t.end_date > NOW()
         GROUP BY t.id
         ORDER BY t.prize_pool DESC`
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting active tournaments:', error);
      return [];
    }
  }

  /**
   * Get upcoming tournaments
   */
  async getUpcomingTournaments() {
    try {
      const result = await pool.query(
        `SELECT * FROM tournaments
         WHERE status = 'upcoming'
         AND start_date > NOW()
         ORDER BY start_date ASC
         LIMIT 5`
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting upcoming tournaments:', error);
      return [];
    }
  }

  /**
   * Get tournament by ID
   */
  async getTournamentById(tournamentId) {
    try {
      const result = await pool.query(
        `SELECT 
          t.*,
          COUNT(tp.id) as participant_count
         FROM tournaments t
         LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
         WHERE t.id = $1
         GROUP BY t.id`,
        [tournamentId]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error getting tournament by ID:', error);
      return null;
    }
  }

  /**
   * Check if user is in a tournament
   */
  async isUserInTournament(userId, tournamentId) {
    try {
      const result = await pool.query(
        'SELECT id FROM tournament_participants WHERE user_id = $1 AND tournament_id = $2',
        [userId, tournamentId]
      );

      return result.rows.length > 0;
    } catch (error) {
      logger.error('Error checking tournament participation:', error);
      return false;
    }
  }

  /**
   * Join a tournament
   */
  async joinTournament(userId, tournamentId, paymentReference = null) {
    try {
      // Check if tournament exists and is active
      const tournament = await this.getTournamentById(tournamentId);

      if (!tournament) {
        return { success: false, error: 'Tournament not found' };
      }

      if (tournament.status !== 'active') {
        return { success: false, error: 'Tournament is not active' };
      }

      // Check if already joined
      const alreadyJoined = await this.isUserInTournament(userId, tournamentId);
      if (alreadyJoined) {
        return { success: false, error: 'Already joined' };
      }

      // Check max participants
      if (tournament.max_participants && tournament.participant_count >= tournament.max_participants) {
        return { success: false, error: 'Tournament is full' };
      }

      // Join tournament
      const entryPaid = tournament.entry_fee === 0 || paymentReference !== null;

      const result = await pool.query(
        `INSERT INTO tournament_participants (tournament_id, user_id, entry_paid, payment_reference)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tournamentId, userId, entryPaid, paymentReference]
      );

      logger.info(`User ${userId} joined tournament ${tournamentId}`);

      return { success: true, participant: result.rows[0] };
    } catch (error) {
      logger.error('Error joining tournament:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update tournament participant score
   */
  async updateParticipantScore(userId, tournamentId, score) {
    try {
      const result = await pool.query(
        `UPDATE tournament_participants
         SET games_played = games_played + 1,
             best_score = GREATEST(best_score, $1),
             total_score = total_score + $1
         WHERE user_id = $2 AND tournament_id = $3
         RETURNING *`,
        [score, userId, tournamentId]
      );

      if (result.rows.length > 0) {
        // Recalculate rankings
        await this.updateTournamentRankings(tournamentId);
        logger.info(`Updated tournament score for user ${userId}: ${score}`);
      }

      return result.rows[0] || null;
    } catch (error) {
      logger.error('Error updating participant score:', error);
      return null;
    }
  }

  /**
   * Update tournament rankings
   */
  async updateTournamentRankings(tournamentId) {
    try {
      await pool.query(
        `WITH ranked_participants AS (
          SELECT 
            id,
            ROW_NUMBER() OVER (ORDER BY best_score DESC, joined_at ASC) as new_rank
          FROM tournament_participants
          WHERE tournament_id = $1
        )
        UPDATE tournament_participants tp
        SET rank = rp.new_rank
        FROM ranked_participants rp
        WHERE tp.id = rp.id`,
        [tournamentId]
      );

      logger.info(`Updated rankings for tournament ${tournamentId}`);
    } catch (error) {
      logger.error('Error updating tournament rankings:', error);
    }
  }

  /**
   * Get tournament leaderboard
   */
  async getTournamentLeaderboard(tournamentId, limit = 50) {
    try {
      const result = await pool.query(
        `SELECT 
          tp.rank,
          tp.best_score,
          tp.games_played,
          tp.prize_won,
          u.username,
          u.full_name,
          u.city
         FROM tournament_participants tp
         JOIN users u ON tp.user_id = u.id
         WHERE tp.tournament_id = $1
         ORDER BY tp.rank ASC
         LIMIT $2`,
        [tournamentId, limit]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting tournament leaderboard:', error);
      return [];
    }
  }

  /**
   * Get user's tournaments
   */
  async getUserTournaments(userId) {
    try {
      const result = await pool.query(
        `SELECT 
          t.*,
          tp.rank,
          tp.best_score,
          tp.games_played,
          tp.prize_won,
          tp.entry_paid
         FROM tournament_participants tp
         JOIN tournaments t ON tp.tournament_id = t.id
         WHERE tp.user_id = $1
         ORDER BY t.end_date DESC
         LIMIT 10`,
        [userId]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting user tournaments:', error);
      return [];
    }
  }

  /**
   * Create a new tournament (Admin only)
   */
  async createTournament(tournamentData) {
    try {
      const {
        tournamentName,
        tournamentType,
        sponsorName,
        sponsorLogoUrl,
        description,
        entryFee,
        prizePool,
        maxParticipants,
        startDate,
        endDate,
        questionsCategory,
        difficultyRange,
        totalQuestions
      } = tournamentData;

      const result = await pool.query(
        `INSERT INTO tournaments (
          tournament_name, tournament_type, sponsor_name, sponsor_logo_url,
          description, entry_fee, prize_pool, max_participants,
          start_date, end_date, questions_category, difficulty_range, total_questions
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          tournamentName, tournamentType, sponsorName, sponsorLogoUrl,
          description, entryFee, prizePool, maxParticipants,
          startDate, endDate, questionsCategory, difficultyRange, totalQuestions || 15
        ]
      );

      logger.info(`Tournament created: ${result.rows[0].id} - ${tournamentName}`);

      return { success: true, tournament: result.rows[0] };
    } catch (error) {
      logger.error('Error creating tournament:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * End a tournament and distribute prizes
   */
  async endTournament(tournamentId) {
    try {
      const tournament = await this.getTournamentById(tournamentId);

      if (!tournament) {
        return { success: false, error: 'Tournament not found' };
      }

      // Get prize distribution (simple: top 10 split the pool)
      const leaderboard = await this.getTournamentLeaderboard(tournamentId, 10);
      
      if (leaderboard.length === 0) {
        // No participants, just mark as completed
        await pool.query(
          'UPDATE tournaments SET status = $1 WHERE id = $2',
          ['completed', tournamentId]
        );
        return { success: true, message: 'Tournament ended with no participants' };
      }

      // Prize distribution percentages (top 10)
      const prizeDistribution = [0.40, 0.20, 0.15, 0.10, 0.05, 0.03, 0.03, 0.02, 0.01, 0.01];
      
      for (let i = 0; i < Math.min(leaderboard.length, 10); i++) {
        const prize = Math.floor(tournament.prize_pool * prizeDistribution[i]);
        
        await pool.query(
          `UPDATE tournament_participants
           SET prize_won = $1
           WHERE tournament_id = $2 AND rank = $3`,
          [prize, tournamentId, i + 1]
        );

        // Create prize transaction
        const participant = leaderboard[i];
        await pool.query(
          `INSERT INTO transactions (user_id, amount, transaction_type, payment_status, session_id)
           SELECT $1, $2, 'prize', 'pending', 
           (SELECT id FROM game_sessions WHERE user_id = $1 AND tournament_id = $3 ORDER BY completed_at DESC LIMIT 1)
           WHERE NOT EXISTS (
             SELECT 1 FROM transactions 
             WHERE user_id = $1 
             AND session_id = (SELECT id FROM game_sessions WHERE user_id = $1 AND tournament_id = $3 ORDER BY completed_at DESC LIMIT 1)
           )`,
          [participant.user_id, prize, tournamentId]
        );
      }

      // Mark tournament as completed
      await pool.query(
        'UPDATE tournaments SET status = $1 WHERE id = $2',
        ['completed', tournamentId]
      );

      logger.info(`Tournament ${tournamentId} ended. Prizes distributed to ${Math.min(leaderboard.length, 10)} winners.`);

      return { success: true, winnersCount: Math.min(leaderboard.length, 10) };
    } catch (error) {
      logger.error('Error ending tournament:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get tournament analytics
   */
  async getTournamentAnalytics() {
    try {
      const result = await pool.query(`
        SELECT 
          COUNT(*) as total_tournaments,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_tournaments,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_tournaments,
          SUM(prize_pool) as total_prize_pool,
          SUM(CASE WHEN status = 'completed' THEN prize_pool ELSE 0 END) as distributed_prizes
        FROM tournaments
      `);

      return result.rows[0];
    } catch (error) {
      logger.error('Error getting tournament analytics:', error);
      throw error;
    }
  }
}

module.exports = TournamentService;