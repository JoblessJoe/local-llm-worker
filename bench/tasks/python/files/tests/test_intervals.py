import copy
import pytest
from intervals import merge_intervals

def test_overlap():
    assert merge_intervals([[1, 5], [3, 8]]) == [[1, 8]]

def test_touching():
    assert merge_intervals([[1, 2], [2, 3], [5, 6]]) == [[1, 3], [5, 6]]

def test_sorted():
    assert merge_intervals([[10, 12], [1, 2], [4, 5]]) == [[1, 2], [4, 5], [10, 12]]

def test_no_mutation_and_empty():
    data = [[3, 4], [1, 3]]
    before = copy.deepcopy(data)
    merge_intervals(data)
    assert data == before
    assert merge_intervals([]) == []

def test_invalid():
    with pytest.raises(ValueError):
        merge_intervals([[5, 1]])
