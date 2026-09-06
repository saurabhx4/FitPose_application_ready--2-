// Central exercise catalog — shared by the Exercise Library and the Workout page.
// `calorieRate` is an approximate calories-burned-per-minute figure for an
// average adult doing that movement (MET-based), so a recorded session's
// calorie total scales with BOTH which workout was selected AND how long it
// actually ran for, instead of a single flat rate for every exercise.
// `steps` power the "Exercise Preview" modal — a short numbered how-to that
// plays alongside a real video/GIF demo of the movement (see `media` per
// exercise below and exercisePreview.js).
export const EXERCISES = [
  {
    id: 'cat-cow', thumb: '/media/exercises/thumbs/cat-cow.jpg', name: 'Cat-Cow Stretch', category: 'Mobility', difficulty: 'Beginner', duration: 6, emoji: '🧘',
    desc: 'Spine mobility · gentle flow', target: 'cat-cow', calorieRate: 2.8, media: { src: '/media/exercises/cat-cow.mp4', type: 'video' },
    steps: [
      'Start on all fours, wrists under shoulders, knees under hips.',
      'Inhale — drop your belly, lift your chest and tailbone (Cow).',
      'Exhale — round your spine toward the ceiling, tuck your chin (Cat).',
      'Flow slowly between the two for the full set, moving with your breath.',
    ],
  },
  {
    id: 'squat', thumb: '/media/exercises/thumbs/squat.jpg', name: 'Bodyweight Squat', category: 'Strength', difficulty: 'Medium', duration: 10, emoji: '🏋️',
    desc: 'Lower body strength', target: 'squats', calorieRate: 8.0, media: { src: '/media/exercises/squat.mp4', type: 'video' },
    steps: [
      'Stand with feet shoulder-width apart, chest up, gaze forward.',
      'Bend your knees and push your hips back like sitting in a chair.',
      'Lower until your knees reach about a 90° angle, knees tracking over toes.',
      'Push through your heels to stand back up, squeezing your glutes at the top.',
    ],
  },
  {
    id: 'hip-flexor', thumb: '/media/exercises/thumbs/hip-flexor.jpg', name: 'Hip Flexor Stretch', category: 'Posture', difficulty: 'Beginner', duration: 7, emoji: '🧎',
    desc: 'Mobility & posture reset', target: 'hip-flexor', calorieRate: 3.2, media: { src: '/media/exercises/hip-flexor.mp4', type: 'video' },
    steps: [
      'Kneel on one knee in a half-lunge position, front foot flat on the floor.',
      'Keep your torso upright and gently tuck your pelvis under.',
      'Shift your weight forward until you feel a stretch at the front of the back hip.',
      'Hold, breathing steadily, then switch sides.',
    ],
  },
  {
    id: 'push-up', thumb: '/media/exercises/thumbs/push-up.jpg', name: 'Push-Up', category: 'Strength', difficulty: 'Medium', duration: 8, emoji: '💪',
    desc: 'Upper body & core', target: 'push-up', calorieRate: 7.5, media: { src: '/media/exercises/push-up.gif', type: 'gif' },
    steps: [
      'Start in a high plank, hands slightly wider than shoulders.',
      'Keep a straight line from your shoulders to your heels.',
      'Bend your elbows and lower your chest toward the floor.',
      'Push back up to the starting position without letting your hips sag.',
    ],
  },
  {
    id: 'plank', thumb: '/media/exercises/thumbs/plank.jpg', name: 'Plank Hold', category: 'Strength', difficulty: 'Medium', duration: 5, emoji: '🧍',
    desc: 'Core stability', target: 'plank', calorieRate: 5.5, media: { src: '/media/exercises/plank.mp4', type: 'video' },
    steps: [
      'Rest on your forearms and toes, elbows under shoulders.',
      'Keep your body in one straight line from head to heels.',
      'Brace your core and squeeze your glutes to avoid hip sag.',
      'Keep your neck neutral, gaze slightly forward, and breathe steadily.',
    ],
  },
  {
    id: 'shoulder-raise', thumb: '/media/exercises/thumbs/shoulder-raise.jpg', name: 'Shoulder Raise', category: 'Posture', difficulty: 'Beginner', duration: 6, emoji: '🙆',
    desc: 'Shoulder mobility & posture', target: 'shoulder-raise', calorieRate: 3.5, media: { src: '/media/exercises/shoulder-raise.mp4', type: 'video' },
    steps: [
      'Stand tall with arms relaxed by your sides.',
      'With a soft bend in your elbows, raise your arms out to shoulder height.',
      'Keep your shoulders down, away from your ears.',
      'Lower with control back to the starting position.',
    ],
  },
  {
    id: 'neck-stretch', thumb: '/media/exercises/thumbs/neck-stretch.jpg', name: 'Neck Stretch', category: 'Posture', difficulty: 'Beginner', duration: 4, emoji: '🙂',
    desc: 'Release neck tension', target: 'neck-stretch', calorieRate: 2.0, media: { src: '/media/exercises/neck-stretch.mp4', type: 'video' },
    steps: [
      'Sit or stand tall with relaxed shoulders.',
      'Gently tilt your head toward one shoulder until you feel a stretch.',
      'Hold, breathing steadily, then return to center.',
      'Repeat on the other side, keeping the movement slow and gentle.',
    ],
  },
  {
    id: 'hip-rotation', thumb: '/media/exercises/thumbs/hip-rotation.jpg', name: 'Hip Rotation', category: 'Mobility', difficulty: 'Beginner', duration: 5, emoji: '🤸',
    desc: 'Hip mobility flow', target: 'hip-rotation', calorieRate: 3.4, media: { src: '/media/exercises/hip-rotation.mp4', type: 'video' },
    steps: [
      'Stand tall, hands on your hips for balance.',
      'Lift one knee toward your hip and rotate it outward in a circle.',
      'Keep your standing leg stable and your core engaged.',
      'Reverse the direction, then repeat on the other side.',
    ],
  },


  {
    id: 'a01-deep-squat', thumb: '/media/exercises/thumbs/a01-deep-squat.jpg', code: 'A01', name: 'Deep Squat', category: 'Functional', difficulty: 'Medium', duration: 8, emoji: '🏋️',
    desc: 'Lower body mobility & strength', target: 'a01-deep-squat', calorieRate: 7.5, media: { src: '/media/exercises/deep-squat.mp4', type: 'video' },
    steps: [
      'Stand with your feet about shoulder-width apart, toes slightly turned out, and keep your chest lifted.',
      'Brace your core, push your hips back, and bend your knees to lower into a deep squat as comfortably as you can.',
      'Keep your knees tracking over your toes and your heels grounded throughout the movement.',
      'Drive through your feet to return to standing, keeping the movement smooth and controlled.',
    ],
  },
  {
    id: 'a02-hurdle-step', thumb: '/media/exercises/thumbs/a02-hurdle-step.jpg', code: 'A02', name: 'Hurdle Step', category: 'Functional', difficulty: 'Medium', duration: 6, emoji: '🚶',
    desc: 'Balance, hip mobility & coordination', target: 'a02-hurdle-step', calorieRate: 4.0,
    steps: [
      'Stand tall facing forward with your feet hip-width apart and hands relaxed at your sides.',
      'Lift one knee and move the leg forward and over an imaginary low hurdle without leaning your torso.',
      'Place the foot down gently, keeping your standing leg stable and your hips level.',
      'Bring the leg back over the imaginary hurdle to the start, then repeat on the other side.',
    ],
  },
  {
    id: 'a03-inline-lunge', thumb: '/media/exercises/thumbs/a03-inline-lunge.jpg', code: 'A03', name: 'Inline Lunge', category: 'Functional', difficulty: 'Medium', duration: 7, emoji: '🦵',
    desc: 'Single-leg stability & lower body control', target: 'a03-inline-lunge', calorieRate: 6.5, media: { src: '/media/exercises/inline-lunge.gif', type: 'gif' },
    steps: [
      'Stand tall with one foot directly in front of the other, as if standing on a narrow line.',
      'Keep your torso upright and bend both knees to lower your body in a controlled lunge.',
      'Keep the front knee tracking over the foot and maintain balance without collapsing inward.',
      'Push through the front foot to return to the starting position, then switch sides.',
    ],
  },
  {
    id: 'a04-side-lunge', thumb: '/media/exercises/thumbs/a04-side-lunge.jpg', code: 'A04', name: 'Side Lunge', category: 'Functional', difficulty: 'Medium', duration: 7, emoji: '↔️',
    desc: 'Lateral strength & hip mobility', target: 'a04-side-lunge', calorieRate: 6.0, media: { src: '/media/exercises/side-lunge.mp4', type: 'video' },
    steps: [
      'Stand tall with your feet together or hip-width apart and keep your chest lifted.',
      'Take a controlled step out to one side and shift your hips toward that leg.',
      'Bend the stepping knee while keeping the opposite leg relatively straight and both feet grounded.',
      'Push through the bent leg to return to center, then repeat on the other side.',
    ],
  },
  {
    id: 'a05-sit-to-stand', thumb: '/media/exercises/thumbs/a05-sit-to-stand.jpg', code: 'A05', name: 'Sit to Stand', category: 'Functional', difficulty: 'Beginner', duration: 6, emoji: '🪑',
    desc: 'Functional lower body strength', target: 'a05-sit-to-stand', calorieRate: 5.0, media: { src: '/media/exercises/sit-to-stand.mp4', type: 'video' },
    steps: [
      'Sit near the front of a sturdy chair with your feet flat, about hip-width apart.',
      'Lean your torso slightly forward while keeping your back controlled and your knees aligned with your feet.',
      'Press through your feet to stand fully upright without using your hands if comfortable.',
      'Reach your hips back and slowly lower yourself to the chair with control, then repeat.',
    ],
  },
  {
    id: 'a06-standing-active-straight-leg-raise', thumb: '/media/exercises/thumbs/a06-standing-active-straight-leg-raise.jpg', code: 'A06', name: 'Standing Active Straight Leg Raise', category: 'Mobility', difficulty: 'Beginner', duration: 5, emoji: '🦵',
    desc: 'Active hip mobility & hamstring control', target: 'a06-standing-active-straight-leg-raise', calorieRate: 3.5, media: { src: '/media/exercises/standing-active-straight-leg-raise.png', type: 'image' },
    steps: [
      'Stand tall beside a stable support and lightly hold it for balance if needed.',
      'Keep one knee straight and slowly lift that leg forward from the hip without leaning backward.',
      'Raise only as far as you can while keeping the standing leg and pelvis stable.',
      'Lower the leg with control and repeat, then switch sides.',
    ],
  },
  {
    id: 'a07-standing-shoulder-abduction', thumb: '/media/exercises/thumbs/a07-standing-shoulder-abduction.jpg', code: 'A07', name: 'Standing Shoulder Abduction', category: 'Posture', difficulty: 'Beginner', duration: 5, emoji: '🙆',
    desc: 'Shoulder mobility & controlled arm elevation', target: 'a07-standing-shoulder-abduction', calorieRate: 3.2, media: { src: '/media/exercises/standing-shoulder-abduction.mp4', type: 'video' },
    steps: [
      'Stand tall with your arms relaxed by your sides and shoulders gently down.',
      'Keeping your elbows comfortably straight, raise both arms out to the sides.',
      'Lift toward shoulder height without shrugging or arching your back.',
      'Lower both arms slowly to the starting position and repeat.',
    ],
  },
  {
    id: 'a08-standing-shoulder-extension', thumb: '/media/exercises/thumbs/a08-standing-shoulder-extension.jpg', code: 'A08', name: 'Standing Shoulder Extension', category: 'Posture', difficulty: 'Beginner', duration: 5, emoji: '🙋',
    desc: 'Shoulder control & posterior mobility', target: 'a08-standing-shoulder-extension', calorieRate: 3.0, media: { src: '/media/exercises/standing-shoulder-extension.mp4', type: 'video' },
    steps: [
      'Stand tall with your arms resting by your sides and your palms facing your thighs.',
      'Keeping your elbows straight or softly bent, move your arms backward from the shoulders.',
      'Stop at a comfortable range without shrugging, arching your lower back, or jutting your head forward.',
      'Return your arms to your sides slowly and repeat with controlled breathing.',
    ],
  },
  {
    id: 'a09-standing-shoulder-internal-external-rotation', thumb: '/media/exercises/thumbs/a09-standing-shoulder-internal-external-rotation.jpg', code: 'A09', name: 'Standing Shoulder Internal–External Rotation', category: 'Posture', difficulty: 'Beginner', duration: 5, emoji: '🔄',
    desc: 'Rotator cuff mobility & shoulder control', target: 'a09-standing-shoulder-internal-external-rotation', calorieRate: 2.8, media: { src: '/media/exercises/shoulder-rotation.mp4', type: 'video' },
    steps: [
      'Stand tall with your elbows bent to about 90° and kept close to your sides.',
      'Keeping the upper arms still, rotate your forearms outward as far as comfortable.',
      'Return to center, then rotate the forearms inward without letting the elbows drift away.',
      'Alternate the rotation slowly, keeping your shoulders relaxed and your torso still.',
    ],
  },
  {
    id: 'a10-standing-shoulder-scaption', thumb: '/media/exercises/thumbs/a10-standing-shoulder-scaption.jpg', code: 'A10', name: 'Standing Shoulder Scaption', category: 'Posture', difficulty: 'Beginner', duration: 5, emoji: '🙌',
    desc: 'Shoulder elevation & scapular control', target: 'a10-standing-shoulder-scaption', calorieRate: 3.2, media: { src: '/media/exercises/standing-shoulder-scaption.gif', type: 'gif' },
    steps: [
      'Stand tall with your arms by your sides and palms facing forward or slightly inward.',
      'Raise your arms in a diagonal plane about 30–45° forward from your sides.',
      'Lift toward shoulder height while keeping your neck relaxed and avoiding a shoulder shrug.',
      'Lower your arms slowly to the starting position and repeat with control.',
    ],
  },

 ];

export function findExercise(id) {
  return EXERCISES.find((e) => e.id === id) || EXERCISES[1];
}
