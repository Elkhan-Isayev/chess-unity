using System;

namespace ChessRules
{
	public class Chess
	{
		public string fen { get; private set; }

		public Chess(string fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
		{
			this.fen = fen;
		}

		public Chess Move (string move)
		{
			Chess nextChess = new Chess(fen);
			return nextChess;
		}

		public char GetFiqureAt(int x, int y)
		{
			return '.';
		}
	}
}

