from app.services.vworld_water import split_bbox


def test_small_bbox_is_not_split():
    boxes = split_bbox((127.0, 37.0, 127.005, 37.005))
    assert boxes == [(127.0, 37.0, 127.005, 37.005)]


def test_large_bbox_is_split_into_valid_boxes():
    boxes = split_bbox((127.0, 37.0, 127.1, 37.1))
    assert len(boxes) > 1
    assert boxes[0][0] == 127.0
    assert boxes[0][1] == 37.0
    assert boxes[-1][2] == 127.1
    assert boxes[-1][3] == 37.1
