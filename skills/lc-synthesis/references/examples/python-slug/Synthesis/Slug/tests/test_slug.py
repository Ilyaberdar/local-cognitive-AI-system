import unittest

from src.slug import slugify


class SlugTest(unittest.TestCase):
    def test_c2_c4_joins_words_with_single_hyphens(self):
        """[C2][C4] words are joined by one hyphen, none at either end"""
        self.assertEqual(slugify("Hello,  World!"), "hello-world")
        self.assertEqual(slugify("  --Already--slugged--  "), "already-slugged")
        self.assertEqual(slugify("Version 2.0 is OUT"), "version-2-0-is-out")

    def test_c3_accents_become_base_letters(self):
        """[C3] accented Latin letters lose their accents; other letters separate words"""
        self.assertEqual(slugify("Crème Brûlée"), "creme-brulee")
        self.assertEqual(slugify("naïve Ünïcode café"), "naive-unicode-cafe")
        self.assertEqual(slugify("Привет мир 2"), "2")

    def test_c5_cuts_at_a_word_boundary(self):
        """[C5] a long slug is cut at a word boundary, a long first word at max_length"""
        self.assertEqual(slugify("the quick brown fox", max_length=12), "the-quick")
        self.assertEqual(slugify("the quick", max_length=9), "the-quick")
        self.assertEqual(slugify("ab cd", max_length=3), "ab")
        self.assertEqual(slugify("supercalifragilistic", max_length=5), "super")
        self.assertEqual(len(slugify("word " * 40)), 59)

    def test_c6_nothing_to_keep_gives_empty(self):
        """[C6] no ASCII letter or digit gives the empty string"""
        self.assertEqual(slugify(""), "")
        self.assertEqual(slugify("!!! --- ???"), "")

    def test_c7_rejects_wrong_arguments(self):
        """[C7] wrong types and lengths raise"""
        with self.assertRaises(TypeError):
            slugify(None)
        with self.assertRaises(TypeError):
            slugify(b"bytes")
        for length in (0, -1, 2.5, True):
            with self.assertRaises(ValueError):
                slugify("text", max_length=length)


if __name__ == "__main__":
    unittest.main()
