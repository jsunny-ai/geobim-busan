from app.services.borehole_source_layout import extract_groundwater_observations


def _layout(elements):
    return {
        "source_document": {"sha256": "a" * 64},
        "pages": [{"page_number": 1, "elements": elements}],
    }


def test_extracts_groundwater_value_with_source_lineage():
    elements = [
        {
            "element_id": "label",
            "text": "지하수위",
            "bbox": [447.8, 126.1, 481.5, 136.5],
        },
        {
            "element_id": "value",
            "text": "4.3",
            "bbox": [493.8, 130.6, 507.1, 141.0],
            "extraction_method": "embedded_text",
        },
        {
            "element_id": "unit",
            "text": "(GL,-m)",
            "bbox": [455.8, 135.2, 473.8, 145.5],
        },
    ]

    observations = extract_groundwater_observations(_layout(elements))

    assert len(observations) == 1
    assert observations[0]["value_numeric"] == 4.3
    assert observations[0]["reference_datum"] == "GL"
    assert observations[0]["source_element_ids"] == ["label", "value", "unit"]
    assert observations[0]["source_bbox"] == [493.8, 130.6, 507.1, 141.0]


def test_ignores_numbers_that_are_not_on_label_row():
    elements = [
        {
            "element_id": "label",
            "text": "지하수위",
            "bbox": [447.8, 126.1, 481.5, 136.5],
        },
        {
            "element_id": "unrelated",
            "text": "25.0",
            "bbox": [493.8, 300.0, 507.1, 310.0],
        },
    ]

    assert extract_groundwater_observations(_layout(elements)) == []


def test_prefers_nearest_same_row_numeric_element():
    elements = [
        {
            "element_id": "label",
            "text": "GWL",
            "bbox": [100.0, 100.0, 125.0, 110.0],
        },
        {
            "element_id": "nearest",
            "text": "2.75",
            "bbox": [135.0, 100.0, 155.0, 110.0],
        },
        {
            "element_id": "farther",
            "text": "99",
            "bbox": [240.0, 100.0, 255.0, 110.0],
        },
    ]

    observations = extract_groundwater_observations(_layout(elements))

    assert observations[0]["value_numeric"] == 2.75
    assert observations[0]["source_element_ids"][:2] == ["label", "nearest"]


def test_parses_el_reference_without_changing_value_sign():
    elements = [
        {
            "element_id": "label",
            "text": "공내수위",
            "bbox": [100.0, 100.0, 130.0, 110.0],
        },
        {
            "element_id": "value",
            "text": "-42.15",
            "bbox": [140.0, 100.0, 170.0, 110.0],
        },
        {
            "element_id": "unit",
            "text": "(EL,m)",
            "bbox": [105.0, 112.0, 135.0, 122.0],
        },
    ]

    observations = extract_groundwater_observations(_layout(elements))

    assert observations[0]["value_numeric"] == -42.15
    assert observations[0]["reference_datum"] == "EL"
