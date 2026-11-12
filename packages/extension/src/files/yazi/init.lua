function Status:redraw()
	local right = self:children_redraw(self.RIGHT)
	local right_width = right:width()
	local left = self:children_redraw(self.LEFT)
	left:truncate({ max = math.max(0, self._area.w - right_width - 2) })
	return {
		ui.Text(""):area(self._area):style(th.status.overall),
		ui.Line(left):area(self._area),
		ui.Line(right):area(self._area):align(ui.Align.RIGHT),
		table.unpack(ui.redraw(Progress:new(self._area, right_width))),
	}
end
