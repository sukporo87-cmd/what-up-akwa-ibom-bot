const WhatsAppService = require('../services/whatsapp.service');
const GameService = require('../services/game.service');
const UserService = require('../services/user.service');
const { logger } = require('../utils/logger');

const whatsappService = new WhatsAppService();
const gameService = new GameService();
const userService = new UserService();

const LGA_LIST = [
  'Abak', 'Eastern Obolo', 'Eket', 'Esit Eket', 'Essien Udim',
  'Etim Ekpo', 'Etinan', 'Ibeno', 'Ibesikpo Asutan', 'Ibiono-Ibom',
  'Ika', 'Ikono', 'Ikot Abasi', 'Ikot Ekpene', 'Ini',
  'Itu', 'Mbo', 'Mkpat-Enin', 'Nsit-Atai', 'Nsit-Ibom',
  'Nsit-Ubium', 'Obot Akara', 'Okobo', 'Onna', 'Oron',
  'Oruk Anam', 'Udung-Uko', 'Ukanafun', 'Uruan', 'Urue-Offong/Oruko', 'Uyo'
];

class WebhookController {
  async verify(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      logger.info('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      logger.error('Webhook verification failed');
      res.status(403).send('Forbidden');
    }
  }

  async handleMessage(req, res) {
    try {
      const body = req.body;
      res.status(200).send('EVENT_RECEIVED');

      if (body.object === 'whatsapp_business_account') {
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const messages = value?.messages;

        if (!messages || messages.length === 0) {
          return;
        }

        const message = messages[0];
        const from = message.from;
        const messageBody = message.text?.body || '';

        logger.info(`Message from ${from}: ${messageBody}`);

        await this.routeMessage(from, messageBody);
      }
    } catch (error) {
      logger.error('Error handling webhook:', error);
    }
  }

  async routeMessage(phone, message) {
    try {
      let user = await userService.getUserByPhone(phone);
      const userState = await userService.getUserState(phone);

      if (userState && userState.state === 'REGISTRATION_NAME') {
        await this.handleRegistrationName(phone, message);
        return;
      }

      if (userState && userState.state === 'REGISTRATION_LGA') {
        await this.handleRegistrationLGA(phone, message, userState.data.name);
        return;
      }

      if (!user) {
        await this.handleNewUser(phone);
        return;
      }

      const activeSession = await gameService.getActiveSession(user.id);

      if (activeSession) {
        await this.handleGameInput(user, activeSession, message);
      } else {
        await this.handleMenuInput(user, message);
      }
    } catch (error) {
      logger.error('Error routing message:', error);
      await whatsappService.sendMessage(
        phone,
        '❌ Sorry, something went wrong. Please try again.'
      );
    }
  }

  async handleNewUser(phone) {
    await whatsappService.sendMessage(
      phone,
      `🎉 Welcome to WHAT'S UP AKWA IBOM! 🎉

The ultimate trivia game about our great state!

Test your knowledge and win amazing prizes! 🏆

Let's get you registered! What's your full name?`
    );

    await userService.setUserState(phone, 'REGISTRATION_NAME');
  }

  async handleRegistrationName(phone, name) {
    if (!name || name.trim().length < 2) {
      await whatsappService.sendMessage(phone, 'Please enter a valid name.');
      return;
    }

    await userService.setUserState(phone, 'REGISTRATION_LGA', { name: name.trim() });

    let lgaMessage = `Nice to meet you, ${name}! 👋\n\nWhich Local Government Area are you from?\n\nReply with the number:\n\n`;
    LGA_LIST.forEach((lga, idx) => {
      lgaMessage += `${idx + 1}. ${lga}\n`;
    });

    await whatsappService.sendMessage(phone, lgaMessage);
  }

  async handleRegistrationLGA(phone, message, name) {
    const lgaIndex = parseInt(message.trim()) - 1;

    if (lgaIndex < 0 || lgaIndex >= LGA_LIST.length) {
      await whatsappService.sendMessage(phone, 'Please reply with a valid number from the list.');
      return;
    }

    const lga = LGA_LIST[lgaIndex];
    const user = await userService.createUser(phone, name, lga);
    await userService.clearUserState(phone);

    await whatsappService.sendMessage(
      phone,
      `✅ Registration complete!

You're all set, ${name} from ${lga}!

Ready to play? Reply:
1️⃣ Play Now
2️⃣ How to Play
3️⃣ Leaderboard`
    );
  }

  async handleMenuInput(user, message) {
    const input = message.trim().toUpperCase();

    if (input === '1' || input.includes('PLAY')) {
      await gameService.startNewGame(user);
    } else if (input === '2' || input.includes('HOW')) {
      await this.sendHowToPlay(user.phone_number);
    } else if (input === '3' || input.includes('LEADERBOARD')) {
      await this.sendLeaderboard(user.phone_number);
    } else {
      await this.sendMainMenu(user.phone_number);
    }
  }

  async handleGameInput(user, session, message) {
    const input = message.trim().toUpperCase();

    if (input.includes('50') || input.includes('5050')) {
      await gameService.useLifeline(session, user, 'fifty_fifty');
      return;
    }

    if (input.includes('SKIP')) {
      await gameService.useLifeline(session, user, 'skip');
      return;
    }

    if (['A', 'B', 'C', 'D'].includes(input)) {
      await gameService.processAnswer(session, user, input);
    } else {
      await whatsappService.sendMessage(
        user.phone_number,
        '⚠️ Please reply with A, B, C, or D\n\nOr use a lifeline:\n- Type "50:50"\n- Type "Skip"'
      );
    }
  }

  async sendMainMenu(phone) {
    await whatsappService.sendMessage(
      phone,
      `🏠 MAIN MENU 🏠

What would you like to do?

1️⃣ Play Now
2️⃣ How to Play
3️⃣ View Leaderboard

Reply with the number of your choice.`
    );
  }

  async sendHowToPlay(phone) {
    await whatsappService.sendMessage(
      phone,
      `📖 HOW TO PLAY 📖

🎯 Answer 15 questions about Akwa Ibom
⏱️ 12 seconds per question
💎 2 lifelines available:
   • 50:50 - Remove 2 wrong answers
   • Skip - Move to next question

🏆 PRIZE LADDER:
Q15: ₦50,000 🥇
Q12: ₦25,000
Q10: ₦10,000 (SAFE)
Q8: ₦5,000
Q5: ₦1,000 (SAFE)

Safe amounts are guaranteed!

Ready to play? Reply "PLAY NOW"`
    );
  }

  async sendLeaderboard(phone) {
    const leaderboard = await gameService.getLeaderboard();
    
    let message = '🏅 TODAY\'S LEADERBOARD 🏅\n\n';
    
    if (leaderboard.length === 0) {
      message += 'No winners yet today! Be the first! 🎯';
    } else {
      leaderboard.forEach((player, index) => {
        const medal = index === 0 ? '🏆' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
        message += `${index + 1}. ${player.full_name} (${player.lga}) - ₦${parseFloat(player.score).toLocaleString()} ${medal}\n`;
      });
    }

    message += '\n\nReply "PLAY NOW" to compete!';

    await whatsappService.sendMessage(phone, message);
  }
}

module.exports = new WebhookController();