import type { SongMetadata } from '../types';

// Clearly labelled offline starters, not AI output or translations of user prompts.
const starters: Record<string, [string[], string[]]> = {
  English: [['The morning finds an open door', 'A little hope I had before', 'I take a breath and find my way', 'A melody to start the day'], ['One small step, one brighter sky', 'Let the quiet moments fly', 'With every note, a place to start', 'A little song, an open heart']],
  Hindi: [['सुबह की किरण खिड़की पे आई', 'मन में फिर एक धुन मुस्काई', 'धीरे धीरे राह बनाऊँ', 'अपने सपनों को गुनगुनाऊँ'], ['चलें ज़रा उस पार कहीं', 'जहाँ उम्मीदें थमती नहीं', 'हर धड़कन में एक नई बात', 'सुरों में ढलती अपनी रात']],
  Punjabi: [['ਸਵੇਰ ਦੀ ਕਿਰਨ ਦਰ ਤੇ ਆਈ', 'ਦਿਲ ਵਿੱਚ ਨਵੀਂ ਉਮੀਦ ਜਗਾਈ', 'ਹੌਲੀ ਹੌਲੀ ਰਾਹ ਬਣਾਵਾਂ', 'ਆਪਣੇ ਸੁਪਨੇ ਗੁਣਗੁਣਾਵਾਂ'], ['ਚੱਲੀਏ ਅੱਗੇ ਹੱਥ ਫੜ ਕੇ', 'ਨਵਾਂ ਸਵੇਰਾ ਨਾਲ ਖੜ੍ਹੇ', 'ਦਿਲ ਦੀ ਧੁਨ ਨੂੰ ਗਾਈਏ ਅੱਜ', 'ਖੁਸ਼ੀਆਂ ਦੇ ਰੰਗ ਲਾਈਏ ਅੱਜ']],
  Spanish: [['La mañana vuelve a despertar', 'Una puerta se abre junto al mar', 'Paso a paso encuentro mi lugar', 'Tengo una canción para empezar'], ['Una nota, un cielo de color', 'Un camino lleno de calor', 'Cada sueño quiere florecer', 'Y mi voz se atreve a renacer']],
  French: [['Le matin dessine un nouveau jour', 'Une note se pose tout autour', 'Pas à pas je retrouve mon chemin', 'Une chanson me prend par la main'], ['Un refrain, un horizon ouvert', 'Quelques mots emportés par le vent', 'Je garde un peu de lumière', 'Pour avancer tout doucement']],
  Arabic: [['ضوء الصباح يطل من بابي', 'واللحن يوقظ أجمل أحلامي', 'أمشي رويدًا والطريق يناديني', 'والأمل الصغير يعود يحييني'], ['نمضي معًا نحو نهار جديد', 'نرسم بالأنغام حلمًا سعيد', 'في كل نبضة حكاية وسلام', 'وفي غدنا تزهر الأيام']],
  Korean: [['창가에 아침이 찾아와', '작은 꿈 하나 눈을 떠', '천천히 길을 걸으며', '새로운 노래를 불러'], ['한 걸음 더 밝은 하늘로', '우리의 마음을 담아서', '작은 멜로디를 따라서', '오늘도 다시 시작해']],
  Japanese: [['窓辺に朝の光が', '小さな夢を起こした', '一歩ずつ道を歩いて', '新しい歌を見つけた'], ['ひとつの音が広がる', '明日の空へ届くように', '心に灯るこの光', 'ゆっくり歌っていこう']],
};
export function starterLyrics(language: string): SongMetadata['lyrics'] {
  const lines = starters[language] || starters.English;
  return [{ section: 'Verse', lines: [...lines[0]] }, { section: 'Chorus', lines: [...lines[1]] }];
}
