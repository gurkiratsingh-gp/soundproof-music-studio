import { AudioLines, ArrowUpRight, SearchX, Headphones } from 'lucide-react';
import type { SongMetadata } from '../types';
import { hashText } from '../utils/songArrangement';
export function CoverArt({ song, large = false }: { song: SongMetadata; large?: boolean }) {
  const variant = hashText(song.genre + song.coverArtSeed) % 4;
  return <div className={'cover-art tone-' + variant + (large ? ' large' : '')} aria-hidden="true"><AudioLines size={large ? 76 : 24} strokeWidth={large ? 1 : 1.6} />{large && <><span className="cover-top">SOUNDPROOF / {song.backingTrack ? 'LOCAL KARAOKE BACKING' : 'ORIGINAL SESSIONS'}</span><span className="cover-bottom">{song.genre.toUpperCase()}<small>{song.language.toUpperCase()}</small></span></>}</div>;
}
export function SongStatus({ song }: { song: SongMetadata }) {
  if (song.backingTrack) return <span className="badge"><Headphones size={11} />Karaoke</span>;
  return <span className="badge neutral">Instrumental</span>;
}
export default function LibraryView({ songs, onSelectSong, selectedSongId, searchQuery = '' }: { songs: SongMetadata[]; onSelectSong: (id: string) => void; selectedSongId?: string | null; searchQuery?: string }) {
  const filtered = songs.filter(song => [song.title, song.genre, song.language, song.description].join(' ').toLowerCase().includes(searchQuery.toLowerCase()));
  if (!filtered.length) return <div className="empty-state"><SearchX size={28} /><h3>{searchQuery ? 'No songs found' : 'Your first song is waiting'}</h3><p>{searchQuery ? 'Try a title, genre, or language.' : 'Head to Create and turn an idea into music.'}</p></div>;
  return <div className="song-list">{filtered.map(song => { const backing = song.backingTrack; return <button key={song.id} className={'song-row ' + (selectedSongId === song.id ? 'active' : '')} onClick={() => onSelectSong(song.id)} aria-pressed={selectedSongId === song.id}><CoverArt song={song} /><span className="song-info"><strong dir="auto">{song.title}</strong><small>{song.genre} <span>·</span> {song.language}</small></span><span className="song-row-status"><SongStatus song={song} /></span><span className="song-bpm">{backing?.bpm || song.bpm}<small>BPM</small></span><ArrowUpRight size={17} className="song-arrow" /></button>; })}</div>;
}

