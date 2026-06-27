using UnityEngine;

public class Board : MonoBehaviour 
{

	// Use this for initialization
	/*
	void Start () 
	{
			
	}
	*/
	DragAndDrop dad = new DragAndDrop();

	// Update is called once per frame
	void Update () 
	{
		dad.Action ();	
	}
}


class DragAndDrop 
{

	State state;
	GameObject item;
	Vector2 offset;

	public DragAndDrop() 
	{
		Drop ();
	}

	enum State 
	{
		none,
		//pickup,
		drag
		//drop
	}
		
	public void Action()
	{
		// Debug.Log (state);
		switch (state) 
		{
		case State.none:
			if(IsMouseButtonPressed())
				PickUp();
			break;
		case State.drag:
			if(IsMouseButtonPressed())
				Drag();
			else
				Drop();
			break;
		}
	}

	bool IsMouseButtonPressed()
	{
		return Input.GetMouseButton (0);
	}

	void PickUp()
	{
		Vector2 clickPosition = GetClickPosition();
		Transform clickedItem = GetItemAt(clickPosition);
		if(clickedItem == null)
			return;
		state = State.drag;
		item = clickedItem.gameObject;
		offset = (Vector2)clickedItem.position - clickPosition;
		Debug.Log (item.name);
	}

	Vector2 GetClickPosition()
	{
		return Camera.main.ScreenToWorldPoint (Input.mousePosition);
	}

	Transform GetItemAt(Vector2 position)
	{
		RaycastHit2D[] fiqures = Physics2D.RaycastAll (position, position, 0.5f);
		if (fiqures.Length == 0)
			return null;
		return fiqures [0].transform;		
	}

	void Drag()
	{
		item.transform.position = GetClickPosition () + offset;
	}

	void Drop()
	{
		state = State.none;
		item = null;
	}
}
