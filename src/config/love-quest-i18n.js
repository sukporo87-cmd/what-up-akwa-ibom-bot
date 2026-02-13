// ============================================
// Love Quest Internationalization (i18n)
// Player-facing message translations
// ============================================

const translations = {
  en: {
    // Welcome / Start
    welcome_title: '💘 *LOVE QUEST BEGINS!* 💘',
    welcome_body: (creatorName, questionCount) =>
      `${creatorName} has prepared ${questionCount} questions about your relationship.`,
    welcome_rules:
      `🎯 Answer correctly to earn Love Points\n🎁 Unlock prizes along the way\n✨ A grand surprise awaits at the end!`,
    welcome_retries: (tries) => `💡 Don't worry - you get ${tries} tries per question!`,
    welcome_ready: `Ready? Here comes the first question... 💕`,

    // Invitation
    invitation_title: `💘 *You've Been Challenged!* 💘`,
    invitation_body: (creatorName) =>
      `${creatorName} has created a special Love Quest just for you!`,
    invitation_features:
      `🎮 Answer questions about your relationship\n🎁 Win prizes at every milestone\n✨ A special surprise awaits at the end...`,
    invitation_cta: `Are you ready to prove your love? 💕\n\nReply *START* to begin your quest!`,

    // Questions
    question_header: (num, total) => `💕 Question ${num} of ${total}`,
    question_timer: (seconds) => `⏱️ Take your time, love... (${seconds}s)`,
    question_hint: `💡 Type HINT if you need help`,

    // Correct answer
    correct_default: `✅ YES! That's right! 🎉\n\n`,
    love_points: (score) => `💕 Love Points: ${score}/1000`,
    prize_unlocked: (text) => `🎁 Prize Unlocked: ${text}`,
    cash_prize: (amount) => `💰 Cash: ₦${amount}`,

    // Wrong answer
    wrong_retry: `💪 Don't give up! Try again...`,
    wrong_tries_left: (n) => `(${n} tries left)`,
    wrong_answer_was: `The answer was:`,
    wrong_continue: `💕 It's okay, love conquers all! Let's continue...`,

    // Default wrong responses
    wrong_responses: (name) => [
      `😤 ${name}! Really?! How could you forget that?!\n\nBut... I still love you. 💕`,
      `😢 Ouch! That wasn't it...\n\nI'm not mad, just... disappointed. 💔\n\nJust kidding! Try again, love!`,
      `🙈 Nooo! That's not right!\n\nWe need to make more memories together! 💕`,
      `😅 Wrong answer, but I'll forgive you...\n\nYou're lucky you're cute! 💕`,
      `💔 *dramatically clutches heart*\n\nHow could you?!\n\n...I'm over it. Let's continue! 😘`,
    ],

    // Hints
    no_hint: `💭 No hint available for this one... Trust your heart! 💕`,
    hint_prefix: (text) => `💡 HINT: ${text}\n\nNow give it another shot! 💕`,

    // Milestones
    milestone_reached: (num, creatorName) =>
      `🎉 *MILESTONE ${num} REACHED!*\n\n${creatorName} has something special for you...`,
    milestone_continue: `💕 Ready to continue?\n\nReply *NEXT* for the next question!`,

    // Video / Audio
    video_message: (creatorName) => `🎬 *${creatorName} has a video message for you:*`,
    voice_message: (creatorName) => `🎤 *${creatorName} has a voice message for you:*`,
    voice_special: (creatorName) => `🎤 *${creatorName} recorded something special for you...*`,

    // Completion
    completion_title: `🎊 CONGRATULATIONS! 🎊`,
    completion_body: `You completed the Love Quest!`,
    completion_score: (score) => `💕 Final Score: ${score}/1000 Love Points`,
    rating_perfect: `🏆 PERFECT LOVE! You know your partner inside out! 💕`,
    rating_deep: `❤️ DEEPLY IN LOVE! Your bond is strong! 💕`,
    rating_growing: `💛 GROWING LOVE! Every day brings you closer! 💕`,
    rating_bloom: `💗 LOVE IN BLOOM! Time to make more memories! 💕`,

    // Grand Reveal
    grand_reveal_anticipation: `✨ *The moment you've been waiting for...* ✨`,
    grand_reveal_personal: (creatorName) => `💌 *A Message From ${creatorName}:*`,
    grand_reveal_final_title: `\n🎊✨💕 *LOVE WINS!* 💕✨🎊`,
    grand_reveal_final_body: (score, creatorName, playerName) =>
      `You scored *${score}/1000* Love Points!\n\n` +
      `This Love Quest was created with love by ${creatorName}\n` +
      `just for you, ${playerName}. 💘`,
    grand_reveal_footer:
      `━━━━━━━━━━━━━━━━━━━━\n_Powered by What's Up Trivia_\n_Create your own Love Quest:_\n_Send "LOVE QUEST" to get started!_`,

    // Cash Prize
    cash_prize_title: `\n💰✨ *GRAND PRIZE UNLOCKED!* ✨💰`,
    cash_prize_body: (creatorName, amount) =>
      `${creatorName} has gifted you:\n\n💵 *₦${amount}*`,
    cash_prize_wallet: `✅ *Added to your What's Up Trivia wallet!*\nYou can claim it anytime by sending CLAIM.`,
    cash_prize_instructions:
      `To claim your prize:\n1️⃣ Register on What's Up Trivia (send "Hello")\n2️⃣ Add your bank details\n3️⃣ Send CLAIM to withdraw`,

    // Poems
    poem_perfect: (playerName, creatorName) =>
      `💕 *For ${playerName}* 💕\n\n` +
      `Every answer proved what I already knew,\n` +
      `That no one knows my heart quite like you.\n` +
      `Through every question, every memory we share,\n` +
      `You showed the world how much you care.\n\n` +
      `*Perfect score. Perfect love. Perfect you.* 💘`,
    poem_deep: (playerName) =>
      `💕 *For ${playerName}* 💕\n\n` +
      `Some answers right, a few went astray,\n` +
      `But love isn't measured that way.\n` +
      `What matters most is you took this chance,\n` +
      `To celebrate our beautiful romance.\n\n` +
      `*Love isn't perfect, but ours is true.* 💘`,
    poem_growing: (playerName) =>
      `💕 *For ${playerName}* 💕\n\n` +
      `The questions were hard, the memories deep,\n` +
      `Some got away, but our love we'll keep.\n` +
      `Every wrong answer is a story to make,\n` +
      `Another memory for our love's sake.\n\n` +
      `*More memories to create together.* 💘`,
    poem_bloom: (playerName) =>
      `💕 *For ${playerName}* 💕\n\n` +
      `You may not remember every little thing,\n` +
      `But that's not what makes a heart sing.\n` +
      `Love is about the moments yet to come,\n` +
      `And with you, my heart is never numb.\n\n` +
      `*Let's make memories you'll never forget.* 💘`,

    // Creator notifications
    creator_complete_title: `💘 *Love Quest Complete!* 💘`,
    creator_complete_body: (playerName) => `${playerName} just finished your Love Quest!`,
    creator_results: `📊 *Results:*`,
    creator_score: (score) => `Score: ${score}/1000 Love Points`,
    creator_rating_perfect: `Rating: 🏆 PERFECT LOVE!\n\nThey know you inside out! 💕`,
    creator_rating_deep: `Rating: ❤️ DEEPLY IN LOVE!\n\nYour bond is strong! 💕`,
    creator_rating_growing: `Rating: 💛 GROWING LOVE!\n\nRoom to make more memories! 💕`,
    creator_rating_bloom: `Rating: 💗 LOVE IN BLOOM!\n\nTime for more adventures together! 💕`,
    creator_footer: `_Thank you for choosing What's Up Trivia!_`,

    // Treasure hunt
    treasure_title: `🗺️ TREASURE HUNT CLUE`,
    treasure_hint: (hint) => `📍 Hint: ${hint}`,
    treasure_cta: `Reply FOUND when you get there! 💕`,
    treasure_found: `🎉 You found it! The adventure continues...\n\nNext question coming up! 💕`,

    // Error
    error_generic: `❌ Sorry, there was an error starting your Love Quest. Please try again by replying START.`,
  },

  es: {
    // Welcome / Start
    welcome_title: '💘 *¡LOVE QUEST COMIENZA!* 💘',
    welcome_body: (creatorName, questionCount) =>
      `${creatorName} ha preparado ${questionCount} preguntas sobre su relación.`,
    welcome_rules:
      `🎯 Responde correctamente para ganar Puntos de Amor\n🎁 Desbloquea premios en el camino\n✨ ¡Una gran sorpresa te espera al final!`,
    welcome_retries: (tries) => `💡 No te preocupes - ¡tienes ${tries} intentos por pregunta!`,
    welcome_ready: `¿Listo/a? Aquí viene la primera pregunta... 💕`,

    // Invitation
    invitation_title: `💘 *¡Te Han Retado!* 💘`,
    invitation_body: (creatorName) =>
      `¡${creatorName} ha creado un Love Quest especial solo para ti!`,
    invitation_features:
      `🎮 Responde preguntas sobre su relación\n🎁 Gana premios en cada etapa\n✨ Una sorpresa especial te espera al final...`,
    invitation_cta: `¿Estás listo/a para demostrar tu amor? 💕\n\n¡Responde *START* para comenzar tu aventura!`,

    // Questions
    question_header: (num, total) => `💕 Pregunta ${num} de ${total}`,
    question_timer: (seconds) => `⏱️ Tómate tu tiempo, amor... (${seconds}s)`,
    question_hint: `💡 Escribe HINT si necesitas ayuda`,

    // Correct answer
    correct_default: `✅ ¡SÍ! ¡Eso es correcto! 🎉\n\n`,
    love_points: (score) => `💕 Puntos de Amor: ${score}/1000`,
    prize_unlocked: (text) => `🎁 Premio Desbloqueado: ${text}`,
    cash_prize: (amount) => `💰 Premio: $${amount}`,

    // Wrong answer
    wrong_retry: `💪 ¡No te rindas! Intenta de nuevo...`,
    wrong_tries_left: (n) => `(${n} intentos restantes)`,
    wrong_answer_was: `La respuesta era:`,
    wrong_continue: `💕 Está bien, ¡el amor lo conquista todo! Continuemos...`,

    // Default wrong responses
    wrong_responses: (name) => [
      `😤 ¡${name}! ¿En serio?! ¡¿Cómo pudiste olvidar eso?!\n\nPero... todavía te amo. 💕`,
      `😢 ¡Ay! Esa no era...\n\nNo estoy enojado/a, solo... decepcionado/a. 💔\n\n¡Es broma! ¡Intenta otra vez, amor!`,
      `🙈 ¡Nooo! ¡Eso no es correcto!\n\n¡Necesitamos crear más recuerdos juntos! 💕`,
      `😅 Respuesta equivocada, pero te perdono...\n\n¡Tienes suerte de ser tan lindo/a! 💕`,
      `💔 *se agarra el corazón dramáticamente*\n\n¡¿Cómo pudiste?!\n\n...Ya lo superé. ¡Continuemos! 😘`,
    ],

    // Hints
    no_hint: `💭 No hay pista disponible para esta... ¡Confía en tu corazón! 💕`,
    hint_prefix: (text) => `💡 PISTA: ${text}\n\n¡Ahora inténtalo otra vez! 💕`,

    // Milestones
    milestone_reached: (num, creatorName) =>
      `🎉 *¡ETAPA ${num} ALCANZADA!*\n\n${creatorName} tiene algo especial para ti...`,
    milestone_continue: `💕 ¿Listo/a para continuar?\n\n¡Responde *NEXT* para la siguiente pregunta!`,

    // Video / Audio
    video_message: (creatorName) => `🎬 *${creatorName} tiene un mensaje de video para ti:*`,
    voice_message: (creatorName) => `🎤 *${creatorName} tiene un mensaje de voz para ti:*`,
    voice_special: (creatorName) => `🎤 *${creatorName} grabó algo especial para ti...*`,

    // Completion
    completion_title: `🎊 ¡FELICIDADES! 🎊`,
    completion_body: `¡Completaste el Love Quest!`,
    completion_score: (score) => `💕 Puntuación Final: ${score}/1000 Puntos de Amor`,
    rating_perfect: `🏆 ¡AMOR PERFECTO! ¡Conoces a tu pareja al derecho y al revés! 💕`,
    rating_deep: `❤️ ¡PROFUNDAMENTE ENAMORADO/A! ¡Su vínculo es fuerte! 💕`,
    rating_growing: `💛 ¡AMOR EN CRECIMIENTO! ¡Cada día los acerca más! 💕`,
    rating_bloom: `💗 ¡AMOR FLORECIENDO! ¡Es hora de crear más recuerdos! 💕`,

    // Grand Reveal
    grand_reveal_anticipation: `✨ *El momento que estabas esperando...* ✨`,
    grand_reveal_personal: (creatorName) => `💌 *Un Mensaje De ${creatorName}:*`,
    grand_reveal_final_title: `\n🎊✨💕 *¡EL AMOR GANA!* 💕✨🎊`,
    grand_reveal_final_body: (score, creatorName, playerName) =>
      `¡Obtuviste *${score}/1000* Puntos de Amor!\n\n` +
      `Este Love Quest fue creado con amor por ${creatorName}\n` +
      `solo para ti, ${playerName}. 💘`,
    grand_reveal_footer:
      `━━━━━━━━━━━━━━━━━━━━\n_Powered by What's Up Trivia_\n_Crea tu propio Love Quest:_\n_¡Envía "LOVE QUEST" para comenzar!_`,

    // Cash Prize
    cash_prize_title: `\n💰✨ *¡GRAN PREMIO DESBLOQUEADO!* ✨💰`,
    cash_prize_body: (creatorName, amount) =>
      `${creatorName} te ha regalado:\n\n💵 *$${amount}*`,
    cash_prize_wallet: `✅ *¡Agregado a tu billetera de What's Up Trivia!*\nPuedes reclamarlo en cualquier momento enviando CLAIM.`,
    cash_prize_instructions:
      `Para reclamar tu premio:\n1️⃣ Regístrate en What's Up Trivia (envía "Hello")\n2️⃣ Agrega tus datos bancarios\n3️⃣ Envía CLAIM para retirar`,

    // Poems
    poem_perfect: (playerName, creatorName) =>
      `💕 *Para ${playerName}* 💕\n\n` +
      `Cada respuesta demostró lo que ya sabía,\n` +
      `Que nadie conoce mi corazón como tú lo hacías.\n` +
      `En cada pregunta, cada recuerdo compartido,\n` +
      `Le mostraste al mundo cuánto te has comprometido.\n\n` +
      `*Puntuación perfecta. Amor perfecto. Tú, perfecto/a.* 💘`,
    poem_deep: (playerName) =>
      `💕 *Para ${playerName}* 💕\n\n` +
      `Algunas respuestas bien, otras se escaparon,\n` +
      `Pero el amor no se mide por las que fallaron.\n` +
      `Lo que importa es que aceptaste este reto,\n` +
      `Para celebrar nuestro romance completo.\n\n` +
      `*El amor no es perfecto, pero el nuestro es real.* 💘`,
    poem_growing: (playerName) =>
      `💕 *Para ${playerName}* 💕\n\n` +
      `Las preguntas fueron difíciles, los recuerdos profundos,\n` +
      `Algunos se escaparon, pero nuestro amor es fecundo.\n` +
      `Cada error es una historia por crear,\n` +
      `Otro recuerdo para nuestro amor guardar.\n\n` +
      `*Más recuerdos por crear juntos.* 💘`,
    poem_bloom: (playerName) =>
      `💕 *Para ${playerName}* 💕\n\n` +
      `Quizás no recuerdes cada pequeño detalle,\n` +
      `Pero eso no es lo que hace que el corazón estalle.\n` +
      `El amor son los momentos que vendrán,\n` +
      `Y contigo, mi corazón siempre latirá.\n\n` +
      `*Hagamos recuerdos que nunca olvidarás.* 💘`,

    // Creator notifications (stay in English - creator is the one who set it up)
    creator_complete_title: `💘 *Love Quest Complete!* 💘`,
    creator_complete_body: (playerName) => `${playerName} just finished your Love Quest!`,
    creator_results: `📊 *Results:*`,
    creator_score: (score) => `Score: ${score}/1000 Love Points`,
    creator_rating_perfect: `Rating: 🏆 PERFECT LOVE!\n\nThey know you inside out! 💕`,
    creator_rating_deep: `Rating: ❤️ DEEPLY IN LOVE!\n\nYour bond is strong! 💕`,
    creator_rating_growing: `Rating: 💛 GROWING LOVE!\n\nRoom to make more memories! 💕`,
    creator_rating_bloom: `Rating: 💗 LOVE IN BLOOM!\n\nTime for more adventures together! 💕`,
    creator_footer: `_Thank you for choosing What's Up Trivia!_`,

    // Treasure hunt
    treasure_title: `🗺️ PISTA DE BÚSQUEDA DEL TESORO`,
    treasure_hint: (hint) => `📍 Pista: ${hint}`,
    treasure_cta: `¡Responde FOUND cuando llegues! 💕`,
    treasure_found: `🎉 ¡Lo encontraste! La aventura continúa...\n\n¡La siguiente pregunta viene en camino! 💕`,

    // Error
    error_generic: `❌ Lo siento, hubo un error al iniciar tu Love Quest. Por favor intenta de nuevo respondiendo START.`,
  },
};

/**
 * Get translation helper for a booking's language
 * @param {string} lang - 'en' or 'es'
 * @returns {object} Translation object
 */
function getTranslations(lang = 'en') {
  return translations[lang] || translations.en;
}

module.exports = { getTranslations, translations };