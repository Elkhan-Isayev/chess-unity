using System;
using ChessRules;

namespace ChessDemo
{
	class Program
	{
		static void Main(string[] args)
		{
			// Console.WriteLine("Hello World!");
			Chess chess = new Chess();
			while(true)
			{
				Console.WriteLine(chess.fen);
				string move = Console.ReadLine();
				if (move == "") break;
				chess = chess.Move(move);
			}
		}
	}
}
